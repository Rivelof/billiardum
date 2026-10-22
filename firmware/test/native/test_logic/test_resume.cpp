// session.resume / session.start той же сессии (§5): фаза и прозвучавшие сигналы сохраняются.
// Сервер шлёт resume при возврате онлайн, после своего перезапуска и по сверке; раньше в ending
// стол пищал после каждого сбоя. Общий сценарий — tools/device-sim/scenarios/19-resume-same-session.json,
// те же случаи у симулятора — tools/device-sim/test/machine-m1.test.mjs.
#include <string>

#include "doctest.h"
#include "support.h"

namespace {

const char* S1 = "0192f3c0-0000-7000-8000-0000000000c1";
const char* S2 = "0192f3c0-0000-7000-8000-0000000000c2";

bl::Json session(const char* id, int64_t remaining, int64_t graceMs = -1) {
  bl::Json b = bl::Json::object();
  b.set("session_id", bl::Json::string(id));
  b.set("remaining_ms", bl::Json::integer(remaining));
  if (graceMs >= 0) b.set("grace_ms", bl::Json::integer(graceMs));
  b.set("buzzer", bl::Json::boolean(true));
  return b;
}

bool ackOk(const bl::Json& ack) { return ack.get("ok") && ack.get("ok")->asBool(); }

std::string mode(test::Rig& rig) { return rig.state().get("mode")->asString(); }

std::string savedSession(bl::MemoryNvs& nvs) {
  std::string s;
  if (!nvs.get(bl::nvs_keys::kSession, s)) return "none";
  bl::Json j;
  bl::parseJson(s, j, bl::ParseMode::Strict);
  return bl::intToString(j.get("remaining_ms")->asInt()) + "/" + bl::intToString(j.get("offline_resumes")->asInt());
}

}  // namespace

TEST_CASE("session.resume той же сессии в ending: ни писка, ни мигания, ни relay; новая сессия — сигналы с нуля") {
  test::Rig rig;
  rig.boot(0);
  rig.machine->setOnline(true);
  rig.send("session.start", session(S1, 400000));
  rig.advance(100000);
  CHECK(rig.rec.warn == 1);
  CHECK(rig.hal.beeps == 2);
  for (int i = 0; i < 5; ++i) {
    rig.machine->setOnline(false);
    rig.advance(10000);
    rig.machine->setOnline(true);
    bl::Json ack = rig.send("session.resume", session(S1, rig.state().get("remaining_ms")->asInt()));
    CHECK(ackOk(ack));
  }
  CHECK_MESSAGE(rig.rec.warn == 1, "пять возвратов онлайн — без сигналов");
  CHECK(rig.rec.beep == 2);
  CHECK(rig.hal.beeps == 2);
  CHECK(rig.rec.blink2 == 0);
  CHECK(rig.rec.relayOnCmds.size() == 1);
  CHECK(mode(rig) == "ending");
  CHECK(rig.state().get("led")->asString() == "yellow_blink");

  // Порог warn_ms[1] по времени — один раз; resume в этой фазе мигание не повторяет и не обрывает.
  rig.advance(rig.state().get("remaining_ms")->asInt() - 60000);
  CHECK(rig.rec.blink2 == 1);
  CHECK_FALSE(rig.machine->lamp());
  rig.send("session.resume", session(S1, 59000));
  CHECK(rig.rec.blink2 == 1);
  CHECK_FALSE(rig.machine->lamp());
  rig.advance(1000);
  CHECK(rig.machine->lamp());
  CHECK(rig.rec.blink2 == 1);

  // Та же сессия через session.start — тоже без сигнала.
  rig.send("session.start", session(S1, 50000));
  CHECK(rig.rec.blink2 == 1);
  CHECK(rig.rec.warn == 1);

  // Другая сессия — сигналы с нуля.
  rig.send("session.start", session(S2, 50000));
  CHECK(rig.rec.blink2 == 2);
  CHECK(rig.state().get("session_id")->asString() == S2);
}

TEST_CASE("session.resume той же сессии в другую фазу: сигнал этой фазы один раз; выше порога — взвод") {
  test::Rig rig;
  rig.boot(0);
  rig.send("session.start", session(S1, 50000));
  CHECK(rig.rec.blink2 == 1);
  CHECK(rig.rec.warn == 0);
  rig.send("session.resume", session(S1, 200000));
  CHECK(rig.rec.warn == 1);
  CHECK(rig.hal.beeps == 2);
  rig.send("session.resume", session(S1, 190000));
  CHECK(rig.rec.warn == 1);
  rig.send("session.resume", session(S1, 1000000));
  CHECK(mode(rig) == "active");
  rig.advance(700000);
  CHECK(rig.rec.warn == 2);
  CHECK(rig.hal.beeps == 4);
}

TEST_CASE("session.resume той же сессии из льготы: выход из льготы без повтора сигнала льготы") {
  test::Rig rig;
  rig.boot(0);
  rig.send("session.start", session(S1, 30000, 120000));
  rig.advance(40000);
  CHECK(mode(rig) == "grace");
  CHECK(rig.rec.grace == 1);
  int blinks = rig.rec.graceBlink;
  rig.send("session.resume", session(S1, 200000));
  CHECK(mode(rig) == "ending");
  CHECK(rig.machine->lamp());
  CHECK(rig.rec.warn == 1);
  rig.send("session.resume", session(S1, 190000));
  CHECK(rig.rec.warn == 1);
  CHECK(rig.rec.grace == 1);
  rig.advance(60000);
  CHECK_MESSAGE(rig.rec.graceBlink == blinks, "мигание льготы снято");
}

TEST_CASE("session.resume той же сессии после продолжения без сервера: остаток сервера, offline_resumes = 0") {
  bl::MemoryNvs nvs;
  test::Rig rig(bl::Caps(), &nvs);
  rig.boot(0);
  rig.send("session.start", session(S1, 600000));
  rig.advance(60000);
  rig.boot(rig.now, "brownout");
  rig.advance(bl::kBootWaitMs);
  CHECK(mode(rig) == "active");
  CHECK(savedSession(nvs) == "480000/1");
  CHECK(ackOk(rig.send("session.resume", session(S1, 500000))));
  CHECK(rig.state().get("remaining_ms")->asInt() == 500000);
  CHECK(savedSession(nvs) == "500000/0");
}
