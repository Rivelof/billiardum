// Конечный автомат контроллера стола — docs/protocol.md §3–§5. Чистый C++ без Arduino.
//
// Модель времени — «сроки»: автомат хранит абсолютные моменты (мс монотонных часов,
// esp_timer_get_time()/1000) следующих внутренних событий. tick(now) обрабатывает все сроки
// до now по порядку, каждый в свой момент; события одного момента — в постоянном порядке (runDue).
// Симулятор (tools/device-sim/lib/machine.mjs) устроен так же, поэтому общие сценарии
// tools/device-sim/scenarios/*.json дают одинаковый результат. Расхождение — дефект.
//
// Правила, которые автомат держит сам: после старта реле выключено; время продлевает только
// session.extend с верной подписью и seq; без связи сессия доигрывается до конца остатка и льготы;
// сигналы конца игры — локально; после перезагрузки — правило 4 (decisions №30).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "bl_body.h"
#include "bl_crypto.h"
#include "bl_events.h"
#include "bl_json.h"
#include "bl_nvs.h"
#include "bl_replay.h"

namespace bl {

constexpr int64_t kStatePeriodMs = 60000;
constexpr int64_t kRejectEventIntervalMs = 10000;  // bad_sig, replayed_seq — не чаще раза в 10 с на тип
constexpr int64_t kBootWaitMs = 30000;             // §5 правило 4
constexpr int64_t kSessionSaveMs = 60000;          // §5 правило 3: S
constexpr int64_t kBlinkOffMs = 300;               // мигание лампой
constexpr int kWarnBeeps = 2;                      // T−5: 2 коротких сигнала
constexpr int64_t kNoDeadline = INT64_MAX;

enum class Mode : uint8_t { Free, Pending, Reserved, Active, Ending, Grace, Service, Fault };
enum class Led : uint8_t { Off, GreenDim, WhiteBlink, Blue, YellowBlink, Red, RedFast, Purple, Identify };

const char* modeName(Mode m);
const char* ledName(Led l);

struct Caps {
  bool relay = true;
  bool led = true;
  bool buzzer = true;
  bool current = true;
  bool dimmer = false;
  Json toJson() const;  // ["relay","led",…] в порядке протокола
};

struct Config {
  int64_t ledBrightness = 128;
  int64_t currentOnMa = 50;
  int64_t currentConfirmMs = 10000;
  int64_t graceDim = 30;
  int64_t graceBlinkS = 15;
  Json toJson() const;
  void merge(const Json& j);
};

struct Signals {
  int warn = 0, beep = 0, blink2 = 0, grace = 0, graceBlink = 0;
};

// Аппаратура стола. Логика зовёт сеттеры только при изменении.
class Hal {
 public:
  virtual ~Hal() = default;
  virtual void setRelay(bool on) = 0;            // физическое реле, с учётом мигания лампой
  virtual void setDim(int pct) = 0;              // 0…100 (если есть dimmer)
  virtual void setLed(Led led, int brightness) = 0;
  virtual void beep(int count) = 0;              // короткие сигналы пищалки
  virtual int32_t currentMa() = 0;               // последнее показание датчика тока, мА
  virtual int rssi() { return 0; }
};

struct CommandReport {
  const char* result = "";  // ok, resend, bad_format, bad_sig, replayed_seq, unknown_type, bad_body, …
  const char* reason = "";
  bool hasEcho = false;
  std::string cmdId;
  int64_t seq = 0;
  std::string type;
};

// Публикации и уведомления платформе.
class Output {
 public:
  virtual ~Output() = default;
  virtual void publishState(const std::string& payload, bool changed) = 0;  // retained
  virtual void publishAck(const std::string& payload, const std::string& cmdId) = 0;
  virtual void eventCreated(const EventEntry& e) = 0;  // отправить то, что вернёт outbox()
  virtual void commandDone(const CommandReport& r) { (void)r; }
  virtual void signal(const char* name, int beeps) { (void)name; (void)beeps; }
  virtual void relayOn(const std::string& cmdId, const char* type) { (void)cmdId; (void)type; }
  virtual void otaStart(const Body& b) { (void)b; }
  virtual void otaAbort() {}
};

using BootIdFn = std::string (*)(void* ctx);  // 8 шестнадцатеричных символов

struct MachineOptions {
  uint8_t key[32] = {0};
  Caps caps;
  std::string fw = "1.0.0";
  Nvs* nvs = nullptr;
  Hal* hal = nullptr;
  Output* out = nullptr;
  HmacFn hmac = hmacSha256Portable;
  BootIdFn bootId = nullptr;
  void* bootIdCtx = nullptr;
  int ringCapacity = kEventRingCapacity;
};

class Machine {
 public:
  explicit Machine(const MachineOptions& o);

  // Загрузка: свет выключен, boot+1, новый boot_id, событие boot, первый state; правило 4.
  void start(int64_t now, const char* resetReason);
  // Обработать сроки до now (loop() прошивки, шаги тестов).
  void tick(int64_t now);
  // Ближайший срок (kNoDeadline — нет).
  int64_t nextDeadline() const;

  CommandReport handleCommand(int64_t now, const uint8_t* data, size_t len);
  void setOnline(bool online);
  void sensorChanged(int64_t now);
  void otaResult(int64_t now, bool ok, const std::string& version, const std::string& error);
  // Загрузчик откатил новую прошивку (она не подключилась к брокеру): ota_failed с error = rollback.
  void otaRolledBack(int64_t now, const std::string& version);
  void publishState(int64_t now);  // без изменения — после подключения к брокеру

  Json snapshot(int64_t now) const;  // state §4
  std::vector<EventEntry> outbox();
  bool eventDelivered(const std::string& bootId, int64_t n);

  Mode mode() const { return reportedMode(); }
  bool lamp() const { return lampOn(); }
  bool relay() const { return relayOn(); }
  int dim() const { return dimLevel(); }
  Led led() const;
  const Signals& signals() const { return signals_; }
  const Config& config() const { return config_; }
  bool bootWaiting() const { return bootPending_; }
  int64_t boot() const { return boot_; }
  const std::string& bootId() const { return bootId_; }
  int64_t lastSeq() const { return lastSeq_; }
  bool otaBusy() const { return otaBusy_; }

 private:
  struct Session {
    std::string id;
    int64_t endAt = 0;
    int64_t warn[2] = {0, 0};
    int64_t grace = 0;
    bool buzzer = false;
    int signaled = 0;  // 0 — нет, 1 — warn[0], 2 — warn[1], 3 — льгота
    int64_t graceEndAt = kNoDeadline;
    int64_t offlineResumes = 0;
  };
  struct SavedSession {
    std::string id;
    int64_t remaining = 0;
    int64_t warn[2] = {0, 0};
    int64_t grace = 0;
    bool buzzer = false;
    int64_t offlineResumes = 0;
  };
  struct Pulse {
    int64_t at;
    bool on;
  };
  struct Detector {
    int64_t since = kNoDeadline;  // kNoDeadline — условия нет
    bool latched = false;
  };
  struct Exec {
    bool ok = true;
    const char* error = "";
    const char* field = "";
    bool force = false;
  };

  CommandReport handle(int64_t now, const uint8_t* data, size_t len);
  Exec execute(CmdType type, const std::string& cmdId, const Json& body, int64_t now);

  void abortOta();
  void resolveBootWait();
  void leaveCurrent(int64_t now);
  void toFree();
  void beginSession(int64_t now, const SavedSession& p, int64_t offlineResumes);
  void continueSession(int64_t now, const SavedSession& p);
  int phaseAt(int64_t now) const;
  void applyPhase(int64_t now, bool byCommand);
  void fireSignal(int64_t now, int phase);
  void enterGrace(int64_t now);
  void graceBlink(int64_t now);
  void startPulses(int64_t now, int count);
  void stopPulses();
  void endSession(int64_t now, bool natural);
  void saveSession(int64_t now);
  void bootWaitExpired(int64_t now);
  bool loadSavedSession(SavedSession& out);

  bool relayOn() const;
  bool lampOn() const;
  int dimLevel() const;
  bool faulty() const { return bypass_.latched || lampFault_.latched; }
  Mode reportedMode() const;
  void applyOutputs();
  void evaluateSensor(int64_t now);
  void sensorDue(int64_t now);

  int64_t sessionDeadline() const;
  int64_t sensorDeadline() const;
  void runDue(int64_t t);
  void advanceTo(int64_t now);
  int64_t sync(int64_t now);

  void sendAck(const std::string& payload, const std::string& cmdId) { out_->publishAck(payload, cmdId); }
  EventEntry makeEvent(const char* type, const Json& data);
  void emitEvent(const char* type, const Json& data);
  void emitRejectEvent(const char* type, const std::string& cmdId, int64_t seq);
  void persistEvents();
  std::string changeKey() const;
  void publish(bool force);

  uint8_t key_[32];
  Caps caps_;
  std::string fw_;
  Nvs& nvs_;
  Hal& hal_;
  Output* out_;
  HmacFn hmac_;
  BootIdFn bootIdFn_;
  void* bootIdCtx_;
  EventRing ring_;

  int64_t t_ = 0;  // время обработки: момент срока или команды; не убывает
  int64_t boot_ = 0;
  std::string bootId_;
  int64_t eventN_ = 0;
  int64_t bootAt_ = 0;
  int64_t stateSeq_ = 0;
  int64_t lastSeq_ = 0;
  std::string lastKey_;
  bool hasLastKey_ = false;
  int64_t periodicAt_ = kNoDeadline;
  bool online_ = false;
  bool hasDroppedEvent_ = false;
  EventEntry droppedEvent_;
  bool droppedPersisted_ = false;
  int64_t rejectAt_[2] = {kNoDeadline, kNoDeadline};  // bad_sig, replayed_seq: uptime последнего события
  int rejectSuppressed_[2] = {0, 0};
  Config config_;

  Mode mode_ = Mode::Free;  // базовое состояние; Fault накладывается поверх Free/Pending/Reserved
  bool hasSession_ = false;
  Session session_;
  bool bootPending_ = false;
  SavedSession pending_;
  int64_t bootWindowAt_ = kNoDeadline;
  int64_t serviceEndAt_ = kNoDeadline;
  int64_t holdEndAt_ = kNoDeadline;
  int64_t identifyEndAt_ = kNoDeadline;
  int64_t checkpointAt_ = kNoDeadline;
  std::vector<Pulse> pulses_;
  bool lampOff_ = false;
  int64_t graceBlinkAt_ = kNoDeadline;
  bool otaBusy_ = false;
  std::string otaVersion_;
  int32_t currentMa_ = 0;
  Detector bypass_;
  Detector lampFault_;
  Signals signals_;

  // Последнее, что отдано в Hal (вызов только при изменении).
  bool halInit_ = false;
  bool halRelay_ = false;
  int halDim_ = 0;
  Led halLed_ = Led::Off;
  int halBrightness_ = 0;
};

}  // namespace bl
