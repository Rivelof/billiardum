// Общее для нативных тестов: поиск репозитория, поддельная аппаратура, запись выходов,
// подпись команд и исполнитель общих сценариев tools/device-sim/scenarios/*.json.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "bl_crypto.h"
#include "bl_json.h"
#include "bl_machine.h"
#include "bl_nvs.h"

namespace test {

// Корень репозитория: BL_REPO_ROOT (переменная окружения или макрос сборки), иначе поиск вверх.
std::string repoRoot();
std::string readFile(const std::string& path);
bl::Json readJsonFile(const std::string& path);  // Relaxed
std::vector<std::string> listJson(const std::string& dir);

extern const char* const kScenarioKeyB64;
std::string decodeB64(const std::string& b64);

// Датчик тока как в симуляторе (lib/scenario.mjs, simSensor): лампа 400 мА × приглушение,
// свет в обход — 380 мА при выключенном реле, неисправная лампа — 0.
class FakeHal : public bl::Hal {
 public:
  void setRelay(bool on) override { relay = on; }
  void setDim(int pct) override { dim = pct; }
  void setLed(bl::Led l, int b) override {
    led = l;
    brightness = b;
  }
  void beep(int count) override { beeps += count; }
  int32_t currentMa() override {
    if (relay) return lampFault ? 0 : (int32_t)(400 * dim / 100);
    return bypass ? 380 : 0;
  }
  int rssi() override { return -55; }

  bool relay = true;  // заведомо «включено» до первого setRelay: проверка, что логика гасит реле сама
  int dim = -1;
  bl::Led led = bl::Led::Identify;
  int brightness = -1;
  int beeps = 0;
  bool bypass = false;
  bool lampFault = false;
};

class Recorder : public bl::Output {
 public:
  void publishState(const std::string& payload, bool changed) override;
  void publishAck(const std::string& payload, const std::string& cmdId) override;
  void eventCreated(const bl::EventEntry& e) override;
  void signal(const char* name, int beeps) override;
  void relayOn(const std::string& cmdId, const char* type) override;
  void otaStart(const bl::Body& b) override;
  void otaAbort() override { order.push_back("ota_abort"); }

  std::vector<std::string> order;  // виды выходов по порядку
  std::vector<std::string> states;
  std::vector<bool> stateChanged;
  std::vector<std::string> acks;
  std::vector<bl::Json> events;
  int warn = 0, beep = 0, blink2 = 0, grace = 0, graceBlink = 0;
  std::vector<std::string> relayOnCmds;
  std::string otaVersion;
};

// Удобная обвязка автомата для юнит-тестов.
struct Rig {
  explicit Rig(bl::Caps caps = bl::Caps(), bl::Nvs* sharedNvs = nullptr, const std::string& keyB64 = kScenarioKeyB64);
  void boot(int64_t at, const char* reason = "poweron");
  bl::Json send(const std::string& type, const bl::Json& body, int64_t seq = -1, const std::string& keyB64 = "");
  bl::Json sendRaw(const std::string& raw);
  void advance(int64_t ms);
  bl::Json state() { return machine->snapshot(now); }
  std::string lastAckRaw() const { return rec.acks.empty() ? std::string() : rec.acks.back(); }

  bl::MemoryNvs ownNvs;
  bl::Nvs* nvs;
  FakeHal hal;
  Recorder rec;
  bl::Caps caps;
  std::string keyB64;
  std::unique_ptr<bl::Machine> machine;
  int64_t now = 0;
  int64_t seq = 0;
  int boots = 0;
  int cmds = 0;
};

// Подписанная команда протокола v1 (поля в порядке v, id, seq, type, issued_at, body, sig).
std::string signCommand(const std::string& keyB64, const std::string& id, int64_t seq, const std::string& type, const bl::Json& body);
std::string commandId(int n);  // 00000000-0000-4000-8000-<n>

// Частичное совпадение как в lib/scenario.mjs: пусто — совпало, иначе описание расхождения.
std::string partialMismatch(const bl::Json& expected, const bl::Json& actual, const std::string& where);
bool jsonEqual(const bl::Json& a, const bl::Json& b);

// Прогон общего сценария; возвращает расхождения.
std::vector<std::string> runScenario(const bl::Json& scenario);

}  // namespace test
