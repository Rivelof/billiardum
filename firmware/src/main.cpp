// Прошивка контроллера стола «Бильярдума» — docs/protocol.md v1.
// Порядок старта: реле выключено → сторож → NVS и ключи → (привязка, если не привязан) → автомат →
// Wi-Fi → MQTT. Логика целиком в lib/logic (bl::Machine), здесь только связывание платформы.
// Не компилировалось в среде агентов: проверяется `pio run -e esp32dev`.
#include <Arduino.h>
#include <WiFi.h>

#include "bl_board.h"
#include "bl_command.h"
#include "bl_drivers.h"
#include "bl_machine.h"
#include "bl_platform.h"
#include "certs.h"

#ifndef BL_FW_VERSION
#define BL_FW_VERSION "0.0.0-dev"
#endif
#ifndef BL_API_URL
#define BL_API_URL "https://billiardum.ru"
#endif

using namespace bl;

namespace {

BoardHal hal;
EspNvs stateNvs;
KeyStore keyStore;
DeviceKeys keys;
OtaUpdater ota(kApiCaPem, kOtaPubKeyPem);
MqttLink* mqtt = nullptr;
Machine* machine = nullptr;
std::string consoleLine;

// Служебная консоль по USB (только физический доступ к плате):
//   factory <device_id> <claim_code> — запись с наклейки на производстве (один раз);
//   wifi <ssid> <пароль>             — смена Wi-Fi клуба без перепривязки;
//   unclaim                          — сброс привязки: при загрузке снова точка доступа;
//   reboot
void handleConsoleLine(const std::string& line) {
  std::string cmd, a, b;
  size_t p1 = line.find(' ');
  cmd = line.substr(0, p1);
  if (p1 != std::string::npos) {
    size_t p2 = line.find(' ', p1 + 1);
    a = line.substr(p1 + 1, p2 == std::string::npos ? std::string::npos : p2 - p1 - 1);
    if (p2 != std::string::npos) b = line.substr(p2 + 1);
  }
  if (cmd == "factory") {
    if (!keys.deviceId.empty()) {
      logLine("console", "\"result\":\"factory_already_set\"");
    } else if (isUuid(a) && b.size() >= 8 && b.size() <= 64 && isPrintableAscii(b)) {
      keyStore.saveFactory(a, b);
      logLine("console", "\"result\":\"factory_saved\"");
      delay(100);
      ESP.restart();
    } else {
      logLine("console", "\"result\":\"bad_factory_args\"");
    }
  } else if (cmd == "wifi" && !a.empty() && a.size() <= 32 && b.size() <= 63) {
    keyStore.saveWifi(a, b);
    logLine("console", "\"result\":\"wifi_saved\"");
    delay(100);
    ESP.restart();
  } else if (cmd == "unclaim") {
    keyStore.eraseClaim();
    logLine("console", "\"result\":\"unclaimed\"");
    delay(100);
    ESP.restart();
  } else if (cmd == "reboot") {
    ESP.restart();
  } else if (!cmd.empty()) {
    logLine("console", "\"result\":\"unknown_command\"");
  }
}

void pollConsole() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      handleConsoleLine(consoleLine);
      consoleLine.clear();
    } else if (consoleLine.size() < 200) {
      consoleLine.push_back(c);
    }
  }
}

}  // namespace

// Arduino-ESP32: новая прошивка после OTA не помечается рабочей при старте —
// это делает OtaUpdater::onBrokerReady после подключения к брокеру (§8).
extern "C" bool verifyRollbackLater() { return true; }

void setup() {
  hal.begin();  // первым делом: реле выключено (§5 правило 4, «после старта реле выключено»)
  Serial.begin(115200);
  watchdogBegin(10);
  logLine("start", std::string("\"fw\":\"") + BL_FW_VERSION + "\",\"reset_reason\":\"" + resetReasonName() + "\"");

  stateNvs.begin("bl_state", false);
  keyStore.begin();
  keyStore.load(keys);

  // Без данных с наклейки работать нельзя: ждём записи на производстве (консоль).
  while (!keys.factoryReady()) {
    static int64_t lastLog = -60000;
    if (nowMs() - lastLog >= 60000) {
      logLine("factory_required", "\"hint\":\"factory <device_id> <claim_code>\"");
      lastLog = nowMs();
    }
    watchdogFeed();
    pollConsole();
    delay(20);
  }
  if (!keys.claimed() || keys.wifiSsid.empty()) {
    runProvisioning(keyStore, keys, stateNvs, kApiCaPem, BL_API_URL);  // заканчивается перезагрузкой
  }

  ota.begin(stateNvs);
  mqtt = new MqttLink(keys, kMqttCaPem, ota);
  MachineOptions o;
  memcpy(o.key, keys.deviceKey, 32);
  o.caps = boardCaps();
  o.fw = BL_FW_VERSION;
  o.nvs = &stateNvs;
  o.hal = &hal;
  o.out = mqtt;
  o.hmac = hmacMbedtls;
  o.bootId = randomBootId;
  machine = new Machine(o);
  mqtt->attach(machine);
  machine->start(nowMs(), resetReasonName());

  wifiBegin(keys);
  if (!mqtt->begin()) logLine("mqtt_init_failed");
}

void loop() {
  watchdogFeed();
  int64_t now = nowMs();
  mqtt->poll(now);
  machine->tick(now);
  ota.poll(*machine, now);
  ota.checkRollbackDeadline(now);
  hal.update((uint32_t)now);
  pollConsole();
  delay(5);
}
