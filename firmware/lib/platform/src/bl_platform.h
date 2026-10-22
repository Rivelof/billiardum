// Платформа ESP32 для логики контроллера (protocol.md §2, §5 правило 3, §7, §8).
// Не компилировалась в среде разработки агентов (реестр PlatformIO закрыт): написана по документации
// ESP-IDF 4.4 / Arduino-ESP32 2.0.17, проверяется `pio run -e esp32dev` у Андрея и в CI.
#pragma once

#include <Arduino.h>
#include <esp_ota_ops.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <mqtt_client.h>
#include <nvs.h>

#include <map>
#include <set>
#include <string>

#include "bl_machine.h"

namespace bl {

// ——— Основы ———

int64_t nowMs();  // монотонные мс: esp_timer_get_time() / 1000, не millis()
void hmacMbedtls(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t* out);
const char* resetReasonName();  // §4: poweron, sw, panic, int_wdt, task_wdt, wdt, deepsleep, brownout, sdio, unknown
std::string randomBootId(void*);
void watchdogBegin(uint32_t timeoutS);
void watchdogFeed();
void logLine(const char* msg, const std::string& fields = "");  // строка JSON в Serial, без секретов

// NVS на разделе данных: bl_state (64 КБ, состояние протокола) или bl_keys (ключи, шифруется).
class EspNvs : public Nvs {
 public:
  bool begin(const char* partition, bool secure);
  bool get(const std::string& key, std::string& out) override;
  bool set(const std::string& key, const std::string& value) override;
  bool erase(const std::string& key) override;
  bool eraseAll();
  bool encrypted() const { return encrypted_; }

 private:
  nvs_handle_t h_ = 0;
  bool ok_ = false;
  bool encrypted_ = false;
};

// Ключи и настройки привязки в разделе bl_keys (§7). device_key и пароль MQTT — разные секреты.
struct DeviceKeys {
  std::string deviceId;   // с наклейки, записывается на производстве
  std::string claimCode;  // одноразовый код привязки с наклейки
  std::string wifiSsid, wifiPass;
  std::string mqttUrl, mqttUser, mqttPass, clubId;
  uint8_t deviceKey[32] = {0};
  bool hasDeviceKey = false;

  bool factoryReady() const { return !deviceId.empty() && !claimCode.empty(); }
  bool claimed() const { return hasDeviceKey && !mqttUrl.empty() && !mqttPass.empty() && !clubId.empty(); }
};

class KeyStore {
 public:
  bool begin();
  void load(DeviceKeys& k);
  bool saveFactory(const std::string& deviceId, const std::string& claimCode);
  bool saveWifi(const std::string& ssid, const std::string& pass);
  bool saveClaim(const std::string& mqttUrl, const std::string& user, const std::string& pass, const std::string& clubId,
                 const uint8_t key[32]);
  void eraseClaim();
  void eraseWifi();
  bool encrypted() const { return nvs_.encrypted(); }

 private:
  EspNvs nvs_;
};

// ——— Связь ———

struct Topics {
  std::string cmd, ack, state, event, status;
  static Topics of(const std::string& clubId, const std::string& deviceId);
};

class OtaUpdater;

// MQTT по TLS с закреплённым CA (esp-mqtt): QoS 1, clean session, keepalive 30 с, Last Will `offline`.
// События клиента приходят из задачи esp-mqtt и обрабатываются в loop() через очередь:
// автомат однопоточный.
class MqttLink : public Output {
 public:
  MqttLink(const DeviceKeys& keys, const char* caPem, OtaUpdater& ota);
  void attach(Machine* m) { machine_ = m; }
  bool begin();
  void poll(int64_t now);
  bool ready() const { return ready_; }

  // Output
  void publishState(const std::string& payload, bool changed) override;
  void publishAck(const std::string& payload, const std::string& cmdId) override;
  void eventCreated(const EventEntry& e) override;
  void commandDone(const CommandReport& r) override;
  void signal(const char* name, int beeps) override;
  void relayOn(const std::string& cmdId, const char* type) override;
  void otaStart(const Body& b) override;
  void otaAbort() override;

 private:
  struct Item {
    int32_t kind;  // esp_mqtt_event_id_t
    int msgId;
    char* data;
    int len;
  };
  static void onEvent(void* arg, esp_event_base_t base, int32_t id, void* data);
  void flushEvents();
  int publish(const std::string& topic, const std::string& payload, bool retain);

  const DeviceKeys& keys_;
  const char* caPem_;
  OtaUpdater& ota_;
  Topics topics_;
  Machine* machine_ = nullptr;
  esp_mqtt_client_handle_t client_ = nullptr;
  QueueHandle_t queue_ = nullptr;
  bool ready_ = false;
  int subMsgId_ = -1;
  std::map<int, std::pair<std::string, int64_t>> inflight_;  // msg_id → (boot_id, n)
  std::set<std::string> inflightKeys_;
  int64_t cmdAt_ = 0;  // для метрики cmd → relay
  // Сборка фрагментированного DATA (команда > буфера клиента).
  std::string partTopic_;
  std::string partData_;
  int partTotal_ = 0;
};

// Wi-Fi клуба (STA) с автоматическим переподключением.
void wifiBegin(const DeviceKeys& keys);

// Привязка (§7): точка доступа Billiardum-XXXX с портальной страницей → Wi-Fi клуба →
// POST /api/devices/claim по HTTPS с закреплённым CA → ключи в bl_keys, обнуление seq, id, ack
// и сессии в bl_state → перезагрузка. Блокирует до успешной привязки (свет всё это время выключен).
void runProvisioning(KeyStore& store, DeviceKeys& keys, Nvs& state, const char* caPem, const char* apiUrl);

// Привязка: один POST /api/devices/claim. Ошибки — кодом для страницы портала.
bool claimDevice(const char* apiUrl, const char* caPem, DeviceKeys& keys, std::string& error);

// ——— Обновление (§8) ———

// esp_https_ota в отдельной задаче; проверка sha256 и подписи образа image_sig (ECDSA P-256,
// открытый ключ закреплён в прошивке) по образу, уже записанному во флеш; перезагрузка только в free;
// новая прошивка помечается рабочей после подключения к брокеру, иначе откат.
class OtaUpdater {
 public:
  OtaUpdater(const char* caPem, const char* pubKeyPem) : caPem_(caPem), pubKeyPem_(pubKeyPem) {}
  void begin(Nvs& state);
  void start(const Body& b);
  void abort();
  // В loop(): итог загрузки → автомат; перезагрузка в новую прошивку, когда стол свободен.
  void poll(Machine& m, int64_t now);
  // Подключились к брокеру: прошивка после обновления становится рабочей, событие ota_ok.
  void onBrokerReady(Machine& m, int64_t now);
  // Нет брокера дольше 10 минут после обновления — откат.
  void checkRollbackDeadline(int64_t now);
  bool busy() const { return busy_; }

 private:
  static void task(void* self);
  void run();
  bool verifyImage(const esp_partition_t* part, int len, std::string& error);

  const char* caPem_;
  const char* pubKeyPem_;
  Nvs* state_ = nullptr;
  Body body_;
  volatile bool busy_ = false;
  volatile bool abort_ = false;
  volatile int result_ = 0;  // 0 — нет, 1 — готово к перезагрузке, -1 — ошибка
  std::string error_;
  bool pendingVerify_ = false;
  int64_t bootAt_ = 0;
  bool finished_ = false;  // загрузочный раздел уже переключён
};

}  // namespace bl
