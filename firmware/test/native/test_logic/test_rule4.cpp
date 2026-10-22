// §5 правило 4 (decisions №30): перезагрузка, 30 с ожидания, «сохранённый − S» один раз за сессию.
// Основные исходы — в общих сценариях 08–10; здесь — края окна ожидания.
#include <string>

#include "doctest.h"
#include "support.h"

namespace {

const char* S1 = "0192f3c0-0000-7000-8000-000000000001";
const char* S2 = "0192f3c0-0000-7000-8000-000000000002";
const char* SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

bl::Json start(const char* id, int64_t remaining) {
  bl::Json b = bl::Json::object();
  b.set("session_id", bl::Json::string(id));
  b.set("remaining_ms", bl::Json::integer(remaining));
  b.set("buzzer", bl::Json::boolean(true));
  return b;
}

bl::Json stop(const char* id) {
  bl::Json b = bl::Json::object();
  b.set("session_id", bl::Json::string(id));
  b.set("reason_code", bl::Json::string("guest_finished"));
  return b;
}

std::string savedRemaining(bl::MemoryNvs& nvs) {
  std::string s;
  if (!nvs.get(bl::nvs_keys::kSession, s)) return "none";
  bl::Json j;
  bl::parseJson(s, j, bl::ParseMode::Strict);
  return bl::intToString(j.get("remaining_ms")->asInt()) + "/" + bl::intToString(j.get("offline_resumes")->asInt());
}

}  // namespace

TEST_CASE("правило 4: в окне свет выключен и остаток не идёт; ping и identify окно не закрывают") {
  bl::MemoryNvs nvs;
  test::Rig rig(bl::Caps(), &nvs);
  rig.boot(0);
  rig.send("session.start", start(S1, 600000));
  rig.advance(61000);
  CHECK(savedRemaining(nvs) == "540000/0");
  rig.boot(rig.now, "brownout");
  CHECK_FALSE(rig.hal.relay);
  CHECK(rig.machine->bootWaiting());
  rig.send("ping", bl::Json::object());
  bl::Json idf = bl::Json::object();
  idf.set("duration_ms", bl::Json::integer(1000));
  rig.send("identify", idf);
  CHECK(rig.machine->bootWaiting());
  rig.advance(29999);
  CHECK(rig.state().get("mode")->asString() == "free");
  CHECK(savedRemaining(nvs) == "540000/0");
  rig.advance(1);
  CHECK(rig.state().get("mode")->asString() == "active");
  CHECK(rig.state().get("remaining_ms")->asInt() == 480000);
  CHECK(rig.hal.relay);
  CHECK(savedRemaining(nvs) == "480000/1");
}

TEST_CASE("правило 4: ota.start в окне — busy_ota; session.stop той же сессии стирает её") {
  bl::MemoryNvs nvs;
  test::Rig rig(bl::Caps(), &nvs);
  rig.boot(0);
  rig.send("session.start", start(S1, 600000));
  rig.advance(61000);
  rig.boot(rig.now);
  bl::Json ota = bl::Json::object();
  ota.set("url", bl::Json::string("https://billiardum.ru/fw/1.0.4.bin"));
  ota.set("version", bl::Json::string("1.0.4"));
  ota.set("sha256", bl::Json::string(SHA));
  ota.set("image_sig", bl::Json::string("AA=="));
  CHECK(rig.send("ota.start", ota).get("error")->asString() == "busy_ota");
  CHECK(rig.send("session.stop", stop(S2)).get("error")->asString() == "wrong_session");
  CHECK(rig.send("session.extend", start(S1, 600000)).get("error")->asString() == "wrong_session");
  CHECK(rig.send("session.stop", stop(S1)).get("ok")->asBool());
  CHECK_FALSE(rig.machine->bootWaiting());
  CHECK(savedRemaining(nvs) == "none");
  rig.advance(60000);
  CHECK(rig.state().get("mode")->asString() == "free");
  CHECK(rig.send("ota.start", ota).get("ok")->asBool());
}

TEST_CASE("правило 4: перезагрузки без сервера не дают ни секунды сверх оплаченного") {
  bl::MemoryNvs nvs;
  test::Rig rig(bl::Caps(), &nvs);
  rig.boot(0);
  rig.send("session.start", start(S1, 600000));
  rig.machine->setOnline(false);
  int64_t lit = 0;  // сколько мс горел свет
  for (int i = 0; i < 20; ++i) {
    for (int k = 0; k < 55; ++k) {
      rig.advance(1000);
      if (rig.hal.relay) lit += 1000;
    }
    rig.boot(rig.now);
  }
  rig.advance(700000);
  CHECK(lit <= 600000);
  CHECK(rig.state().get("mode")->asString() == "free");
  CHECK(savedRemaining(nvs) == "none");
}

TEST_CASE("правило 4: сервер ответил после окна — session.resume заменяет остаток, offline_resumes = 0") {
  bl::MemoryNvs nvs;
  test::Rig rig(bl::Caps(), &nvs);
  rig.boot(0);
  rig.send("session.start", start(S1, 600000));
  rig.advance(120000);
  rig.boot(rig.now);
  rig.advance(30000);
  CHECK(savedRemaining(nvs) == "420000/1");
  rig.send("session.resume", start(S1, 440000));
  CHECK(savedRemaining(nvs) == "440000/0");
  CHECK(rig.state().get("remaining_ms")->asInt() == 440000);
}
