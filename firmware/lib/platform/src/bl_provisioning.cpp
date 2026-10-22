// Привязка контроллера (protocol.md §7, PRODUCT §16):
// 1) точка доступа Billiardum-XXXX (пароль — код привязки с наклейки, если в нём ≥ 8 символов);
// 2) портальная страница: выбор Wi-Fi клуба и пароль;
// 3) подключение к Wi-Fi и POST /api/devices/claim {device_id, claim_code} по HTTPS с закреплённым CA;
// 4) ключи — в bl_keys, seq, id, ack и сессия в bl_state обнуляются, перезагрузка.
// Код привязки принимается сервером только в окне 30 минут, которое открыл владелец в программе клуба.
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_http_client.h>

#include "bl_command.h"
#include "bl_platform.h"

namespace bl {

namespace {

std::string htmlEscape(const String& s) {
  std::string out;
  for (size_t i = 0; i < s.length(); ++i) {
    char c = s[i];
    switch (c) {
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '&': out += "&amp;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out.push_back(c);
    }
  }
  return out;
}

const char kPageHead[] =
    "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Бильярдум — контроллер стола</title>"
    "<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:24px auto;padding:0 16px;color:#0c1424}"
    "label{display:block;margin:12px 0 4px}input,select,button{font-size:16px;width:100%;padding:10px;box-sizing:border-box}"
    "button{margin-top:16px;background:#1a7a4d;color:#fff;border:0;border-radius:8px}.s{margin-top:16px;padding:12px;background:#eef2f7;border-radius:8px}</style>"
    "</head><body><h1>Контроллер стола</h1>";

struct Portal {
  std::string status = "Выберите Wi-Fi клуба и введите пароль.";
  bool connectRequested = false;
  bool done = false;
};

}  // namespace

void wifiBegin(const DeviceKeys& keys) {
  WiFi.persistent(false);  // Wi-Fi клуба хранится в bl_keys, не в NVS ядра
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);  // задержка команд важнее экономии: свет — p95 < 1 с
  WiFi.begin(keys.wifiSsid.c_str(), keys.wifiPass.c_str());
}

bool claimDevice(const char* apiUrl, const char* caPem, DeviceKeys& keys, std::string& error) {
  std::string url = std::string(apiUrl) + "/api/devices/claim";
  esp_http_client_config_t cfg = {};
  cfg.url = url.c_str();
  cfg.method = HTTP_METHOD_POST;
  cfg.cert_pem = caPem;  // закреплённый CA: ключи устройства уходят только нашему серверу
  cfg.timeout_ms = 15000;
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  if (c == nullptr) {
    error = "http_init";
    return false;
  }
  Json req = Json::object();
  req.set("device_id", Json::string(keys.deviceId));
  req.set("claim_code", Json::string(keys.claimCode));
  std::string body = req.dump();
  esp_http_client_set_header(c, "Content-Type", "application/json");
  std::string resp;
  int status = 0;
  if (esp_http_client_open(c, (int)body.size()) != ESP_OK || esp_http_client_write(c, body.data(), (int)body.size()) < 0) {
    error = "network";
  } else {
    esp_http_client_fetch_headers(c);
    status = esp_http_client_get_status_code(c);
    char buf[512];
    int n;
    while ((n = esp_http_client_read(c, buf, sizeof(buf))) > 0 && resp.size() < 4096) resp.append(buf, (size_t)n);
  }
  esp_http_client_close(c);
  esp_http_client_cleanup(c);
  if (status == 0) return false;

  Json j;
  bool parsed = parseJson(resp, j, ParseMode::Relaxed).ok && j.isObject();
  if (status != 200) {
    const Json* e = parsed ? j.get("error") : nullptr;
    error = (e && e->isString() && e->asString().size() <= 32) ? e->asString() : "http_" + intToString(status);
    return false;
  }
  const Json* user = parsed ? j.get("mqtt_username") : nullptr;
  const Json* pass = parsed ? j.get("mqtt_password") : nullptr;
  const Json* key = parsed ? j.get("device_key") : nullptr;
  const Json* mqttUrl = parsed ? j.get("mqtt_url") : nullptr;
  const Json* club = parsed ? j.get("club_id") : nullptr;
  std::string keyBytes;
  if (!user || !user->isString() || !pass || !pass->isString() || pass->asString().empty() || !key || !key->isString() ||
      !base64DecodeStrict(key->asString(), keyBytes) || keyBytes.size() != 32 || !mqttUrl || !mqttUrl->isString() ||
      mqttUrl->asString().compare(0, 8, "mqtts://") != 0 || !club || !club->isString() || !isUuid(club->asString())) {
    error = "bad_response";
    return false;
  }
  keys.mqttUser = user->asString();
  keys.mqttPass = pass->asString();
  keys.mqttUrl = mqttUrl->asString();
  keys.clubId = club->asString();
  memcpy(keys.deviceKey, keyBytes.data(), 32);
  keys.hasDeviceKey = true;
  return true;
}

void runProvisioning(KeyStore& store, DeviceKeys& keys, Nvs& state, const char* caPem, const char* apiUrl) {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char apName[32];
  snprintf(apName, sizeof(apName), "Billiardum-%02X%02X", mac[4], mac[5]);
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName, keys.claimCode.size() >= 8 ? keys.claimCode.c_str() : nullptr);
  logLine("provisioning", std::string("\"ap\":\"") + apName + "\"");

  DNSServer dns;
  dns.start(53, "*", WiFi.softAPIP());  // любая страница открывает портал
  WebServer server(80);
  Portal portal;
  int scanned = WiFi.scanNetworks();

  server.on("/", HTTP_GET, [&]() {
    std::string page = kPageHead;
    page += "<p>Контроллер <b>" + htmlEscape(keys.deviceId.c_str()) + "</b>. Сначала начните привязку в программе клуба: «Добавить контроллер».</p>";
    page += "<form method=\"post\" action=\"/save\"><label for=\"s\">Wi-Fi клуба</label><select id=\"s\" name=\"ssid\">";
    for (int i = 0; i < scanned; ++i) {
      std::string ssid = htmlEscape(WiFi.SSID(i));
      page += "<option value=\"" + ssid + "\">" + ssid + "</option>";
    }
    page += "</select><label for=\"o\">или имя сети вручную</label><input id=\"o\" name=\"ssid_other\" maxlength=\"32\">";
    page += "<label for=\"p\">Пароль Wi-Fi</label><input id=\"p\" name=\"pass\" type=\"password\" maxlength=\"63\">";
    page += "<button type=\"submit\">Подключить</button></form>";
    page += "<div class=\"s\">" + portal.status + "</div></body></html>";
    server.send(200, "text/html; charset=utf-8", page.c_str());
  });
  server.on("/save", HTTP_POST, [&]() {
    String ssid = server.arg("ssid_other").length() > 0 ? server.arg("ssid_other") : server.arg("ssid");
    String pass = server.arg("pass");
    if (ssid.length() == 0 || ssid.length() > 32 || pass.length() > 63) {
      portal.status = "Проверьте имя сети и пароль.";
    } else {
      keys.wifiSsid = ssid.c_str();
      keys.wifiPass = pass.c_str();
      portal.connectRequested = true;
      portal.status = "Подключаюсь к Wi-Fi клуба… Обновите страницу через минуту.";
    }
    server.sendHeader("Location", "/");
    server.send(303);
  });
  server.onNotFound([&]() {
    server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/");
    server.send(302);
  });
  server.begin();

  int64_t connectStarted = -1;
  for (;;) {
    watchdogFeed();
    dns.processNextRequest();
    server.handleClient();
    if (portal.connectRequested) {
      portal.connectRequested = false;
      WiFi.begin(keys.wifiSsid.c_str(), keys.wifiPass.c_str());
      connectStarted = nowMs();
    }
    if (connectStarted >= 0 && WiFi.status() == WL_CONNECTED) {
      connectStarted = -1;
      std::string error;
      if (claimDevice(apiUrl, caPem, keys, error)) {
        store.saveWifi(keys.wifiSsid, keys.wifiPass);
        store.saveClaim(keys.mqttUrl, keys.mqttUser, keys.mqttPass, keys.clubId, keys.deviceKey);
        // §7 п. 6 и §3.2: при привязке контроллер обнуляет seq, id и ack; сессия старой привязки не нужна.
        state.erase(nvs_keys::kReplay);
        state.erase(nvs_keys::kSession);
        portal.status = "Готово: контроллер привязан к столу и перезагружается.";
        logLine("claimed", "\"club_id\":\"" + keys.clubId + "\"");
        portal.done = true;
      } else {
        portal.status = "Не удалось привязать (" + error + "). Проверьте, что привязка начата в программе клуба, и повторите.";
        logLine("claim_failed", "\"error\":\"" + error + "\"");
      }
    }
    if (connectStarted >= 0 && nowMs() - connectStarted > 20000) {
      connectStarted = -1;
      portal.status = "Wi-Fi не подключается: проверьте пароль.";
    }
    if (portal.done) {
      int64_t until = nowMs() + 3000;
      while (nowMs() < until) {
        watchdogFeed();
        server.handleClient();
        delay(10);
      }
      ESP.restart();
    }
    delay(5);
  }
}

}  // namespace bl
