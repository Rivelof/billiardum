// MQTT 3.1.1 по TLS (protocol.md §2): esp-mqtt, QoS 1, clean session, keepalive 30 с,
// Last Will `offline` (retained) в status. После подписки на cmd — `online` (retained) и state,
// затем досылка событий; событие уходит из буфера после PUBACK (MQTT_EVENT_PUBLISHED).
#include <esp_idf_version.h>

#include <cstring>

#include "bl_platform.h"

namespace bl {

namespace {
constexpr int kQueueLen = 16;
constexpr int kMaxCmd = 4096;  // больше — всё равно bad_format (> 2048), сам буфер не растёт
uint8_t kTooLarge[kMaxCommandBytes + 1];  // пустышка длиной 2049: автомат ответит bad_format
}  // namespace

MqttLink::MqttLink(const DeviceKeys& keys, const char* caPem, OtaUpdater& ota)
    : keys_(keys), caPem_(caPem), ota_(ota), topics_(Topics::of(keys.clubId, keys.deviceId)) {}

bool MqttLink::begin() {
  queue_ = xQueueCreate(kQueueLen, sizeof(Item));
  if (queue_ == nullptr) return false;
  esp_mqtt_client_config_t cfg = {};
#if ESP_IDF_VERSION_MAJOR >= 5
  cfg.broker.address.uri = keys_.mqttUrl.c_str();
  cfg.broker.verification.certificate = caPem_;  // закреплённый CA (§2)
  cfg.credentials.client_id = keys_.deviceId.c_str();
  cfg.credentials.username = keys_.mqttUser.empty() ? keys_.deviceId.c_str() : keys_.mqttUser.c_str();
  cfg.credentials.authentication.password = keys_.mqttPass.c_str();
  cfg.session.last_will.topic = topics_.status.c_str();
  cfg.session.last_will.msg = "offline";
  cfg.session.last_will.msg_len = 7;
  cfg.session.last_will.qos = 1;
  cfg.session.last_will.retain = 1;
  cfg.session.disable_clean_session = false;
  cfg.session.keepalive = 30;
  cfg.session.protocol_ver = MQTT_PROTOCOL_V_3_1_1;
  cfg.buffer.size = kMaxCmd;
  cfg.network.reconnect_timeout_ms = 5000;
  cfg.network.timeout_ms = 10000;
#else
  cfg.uri = keys_.mqttUrl.c_str();
  cfg.cert_pem = caPem_;  // закреплённый CA (§2); имя в сертификате проверяется
  cfg.client_id = keys_.deviceId.c_str();
  cfg.username = keys_.mqttUser.empty() ? keys_.deviceId.c_str() : keys_.mqttUser.c_str();
  cfg.password = keys_.mqttPass.c_str();
  cfg.lwt_topic = topics_.status.c_str();
  cfg.lwt_msg = "offline";
  cfg.lwt_msg_len = 7;
  cfg.lwt_qos = 1;
  cfg.lwt_retain = 1;
  cfg.disable_clean_session = 0;  // clean session = true: брокер не копит команды офлайн-устройству
  cfg.keepalive = 30;
  cfg.protocol_ver = MQTT_PROTOCOL_V_3_1_1;
  cfg.buffer_size = kMaxCmd;
  cfg.reconnect_timeout_ms = 5000;
  cfg.network_timeout_ms = 10000;
#endif
  client_ = esp_mqtt_client_init(&cfg);
  if (client_ == nullptr) return false;
  esp_mqtt_client_register_event(client_, (esp_mqtt_event_id_t)ESP_EVENT_ANY_ID, &MqttLink::onEvent, this);
  return esp_mqtt_client_start(client_) == ESP_OK;
}

// Задача esp-mqtt: только копирование в очередь, без логики.
void MqttLink::onEvent(void* arg, esp_event_base_t, int32_t id, void* data) {
  MqttLink* self = static_cast<MqttLink*>(arg);
  esp_mqtt_event_handle_t e = static_cast<esp_mqtt_event_handle_t>(data);
  Item item{id, e->msg_id, nullptr, 0};
  if (id == MQTT_EVENT_DATA) {
    // Фрагменты длинного сообщения собираются в loop(); здесь — копия куска с позицией.
    int len = e->data_len;
    if (len < 0 || len > kMaxCmd) len = 0;
    char* buf = (char*)malloc((size_t)len + (size_t)e->topic_len + 16);
    if (buf == nullptr) return;
    // Формат: [offset:4][total:4][topic_len:4][topic][data]
    memcpy(buf, &e->current_data_offset, 4);
    memcpy(buf + 4, &e->total_data_len, 4);
    memcpy(buf + 8, &e->topic_len, 4);
    if (e->topic_len > 0) memcpy(buf + 12, e->topic, (size_t)e->topic_len);
    memcpy(buf + 12 + (e->topic_len > 0 ? e->topic_len : 0), e->data, (size_t)len);
    item.data = buf;
    item.len = len;
  } else if (id != MQTT_EVENT_CONNECTED && id != MQTT_EVENT_DISCONNECTED && id != MQTT_EVENT_SUBSCRIBED && id != MQTT_EVENT_PUBLISHED) {
    return;
  }
  if (xQueueSend(self->queue_, &item, pdMS_TO_TICKS(100)) != pdTRUE) free(item.data);
}

void MqttLink::poll(int64_t now) {
  Item item;
  while (xQueueReceive(queue_, &item, 0) == pdTRUE) {
    switch (item.kind) {
      case MQTT_EVENT_CONNECTED:
        logLine("mqtt_connected");
        ready_ = false;
        inflight_.clear();
        inflightKeys_.clear();
        subMsgId_ = esp_mqtt_client_subscribe(client_, topics_.cmd.c_str(), 1);
        break;
      case MQTT_EVENT_SUBSCRIBED:
        if (item.msgId == subMsgId_) {
          ready_ = true;
          machine_->setOnline(true);
          publish(topics_.status, "online", true);
          machine_->publishState(now);
          ota_.onBrokerReady(*machine_, now);
          flushEvents();
        }
        break;
      case MQTT_EVENT_DISCONNECTED:
        if (ready_) logLine("mqtt_disconnected");
        ready_ = false;
        machine_->setOnline(false);
        inflight_.clear();
        inflightKeys_.clear();
        partData_.clear();
        break;
      case MQTT_EVENT_PUBLISHED: {
        auto it = inflight_.find(item.msgId);
        if (it != inflight_.end()) {
          machine_->eventDelivered(it->second.first, it->second.second);
          inflightKeys_.erase(it->second.first + ":" + intToString(it->second.second));
          inflight_.erase(it);
        }
        break;
      }
      case MQTT_EVENT_DATA: {
        int32_t offset = 0, total = 0, topicLen = 0;
        memcpy(&offset, item.data, 4);
        memcpy(&total, item.data + 4, 4);
        memcpy(&topicLen, item.data + 8, 4);
        if (offset == 0) {
          partTopic_.assign(item.data + 12, (size_t)(topicLen > 0 ? topicLen : 0));
          partData_.clear();
          partTotal_ = total;
        }
        if (partTotal_ <= kMaxCmd) partData_.append(item.data + 12 + (topicLen > 0 ? topicLen : 0), (size_t)item.len);
        free(item.data);
        if (offset + item.len < partTotal_) break;  // ждём остальные фрагменты
        if (partTopic_ == topics_.cmd) {
          cmdAt_ = nowMs();
          if (partTotal_ > kMaxCmd) {
            machine_->handleCommand(now, kTooLarge, sizeof(kTooLarge));
          } else {
            machine_->handleCommand(now, (const uint8_t*)partData_.data(), partData_.size());
          }
        }
        partData_.clear();
        continue;
      }
      default:
        break;
    }
    free(item.data);
  }
}

int MqttLink::publish(const std::string& topic, const std::string& payload, bool retain) {
  if (client_ == nullptr) return -1;
  return esp_mqtt_client_publish(client_, topic.c_str(), payload.data(), (int)payload.size(), 1, retain ? 1 : 0);
}

void MqttLink::publishState(const std::string& payload, bool changed) {
  if (changed) logLine("state", payload.substr(1, payload.size() - 2));
  if (ready_) publish(topics_.state, payload, true);
}

void MqttLink::publishAck(const std::string& payload, const std::string&) { publish(topics_.ack, payload, false); }

void MqttLink::eventCreated(const EventEntry& e) {
  logLine("event", "\"type\":\"" + e.type + "\",\"n\":" + intToString(e.n));
  flushEvents();
}

void MqttLink::flushEvents() {
  if (!ready_ || machine_ == nullptr) return;
  for (const auto& e : machine_->outbox()) {
    std::string key = e.bootId + ":" + intToString(e.n);
    if (inflightKeys_.count(key)) continue;
    int id = publish(topics_.event, e.payload, false);
    if (id <= 0) break;  // клиент занят или нет связи — досылка после переподключения
    inflight_[id] = {e.bootId, e.n};
    inflightKeys_.insert(key);
  }
}

void MqttLink::commandDone(const CommandReport& r) {
  // В лог — только тип, seq, cmd_id и итог: подпись и тело не пишутся.
  logLine("cmd", "\"type\":\"" + (r.type.size() <= 32 && isPrintableAscii(r.type) ? r.type : std::string("?")) + "\",\"seq\":" +
                     intToString(r.seq) + ",\"cmd_id\":\"" + r.cmdId + "\",\"result\":\"" + r.result + "\"");
}

void MqttLink::signal(const char* name, int beeps) {
  logLine("signal", std::string("\"signal\":\"") + name + "\",\"beeps\":" + intToString(beeps));
}

void MqttLink::relayOn(const std::string& cmdId, const char* type) {
  // Метрика M1: от получения команды до включения реле.
  logLine("relay", "\"relay\":true,\"cmd_id\":\"" + cmdId + "\",\"type\":\"" + type + "\",\"ms_since_cmd\":" + intToString(nowMs() - cmdAt_));
}

void MqttLink::otaStart(const Body& b) { ota_.start(b); }
void MqttLink::otaAbort() { ota_.abort(); }

}  // namespace bl
