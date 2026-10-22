// События §4: boot_id и n, кольцевой буфер на 64, events_dropped, в NVS — только недоставленные,
// ограничение частоты bad_sig и replayed_seq.
#include <string>

#include "bl_events.h"
#include "doctest.h"
#include "support.h"

namespace {

std::string otherKey() { return bl::base64Encode((const uint8_t*)std::string(32, '\x07').data(), 32); }

void deliverAll(bl::Machine& m) {
  for (const auto& e : m.outbox()) m.eventDelivered(e.bootId, e.n);
}

}  // namespace

TEST_CASE("загрузка: boot+1, событие boot с boot_id и n=1, данные fw, caps, reset_reason") {
  test::Rig rig;
  rig.boot(0, "panic");
  REQUIRE(rig.rec.events.size() == 1);
  const bl::Json& e = rig.rec.events[0];
  CHECK(e.dump() == "{\"v\":1,\"boot\":1,\"boot_id\":\"b0000001\",\"n\":1,\"type\":\"boot\",\"at_uptime_ms\":0,\"data\":{\"fw\":\"1.0.0-test\",\"caps\":[\"relay\",\"led\",\"buzzer\",\"current\"],\"reset_reason\":\"panic\"}}");
  rig.boot(5000);
  CHECK(rig.rec.events.back().get("boot")->asInt() == 2);
  CHECK(rig.rec.events.back().get("n")->asInt() == 1);
  CHECK(rig.rec.events.back().get("boot_id")->asString() == "b0000002");
}

TEST_CASE("state по §4: поля и порядок, после старта реле выключено") {
  test::Rig rig;
  CHECK(rig.hal.relay);  // до загрузки «включено» — логика обязана выключить сама
  rig.boot(0);
  CHECK_FALSE(rig.hal.relay);
  CHECK(rig.hal.led == bl::Led::GreenDim);
  CHECK(rig.rec.states.back() ==
        "{\"v\":1,\"state_seq\":1,\"mode\":\"free\",\"session_id\":null,\"remaining_ms\":null,\"relay\":false,\"dim\":0,\"led\":\"green_dim\","
        "\"buzzer\":false,\"current_ma\":0,\"caps\":[\"relay\",\"led\",\"buzzer\",\"current\"],\"fw\":\"1.0.0-test\",\"boot\":1,\"rssi\":-55,"
        "\"uptime_s\":0,\"last_seq\":0}");
  rig.advance(59999);
  CHECK(rig.rec.states.size() == 1);
  rig.advance(1);
  CHECK(rig.rec.states.size() == 2);
  CHECK_FALSE(rig.rec.stateChanged.back());
  bl::Caps noCurrent;
  noCurrent.current = false;
  test::Rig b(noCurrent);
  b.boot(0);
  CHECK(b.state().get("current_ma")->isNull());
}

TEST_CASE("события: в outbox до подтверждения доставки, адресуются (boot_id, n)") {
  test::Rig rig;
  rig.boot(0);
  rig.send("ping", bl::Json::object(), 1, otherKey());
  auto box = rig.machine->outbox();
  REQUIRE(box.size() == 2);
  CHECK(box[0].type == "boot");
  CHECK(box[1].type == "bad_sig");
  CHECK(rig.machine->eventDelivered("b0000001", 1));
  CHECK(rig.machine->outbox().size() == 1);
  CHECK_FALSE(rig.machine->eventDelivered("b0000001", 1));
  CHECK_FALSE(rig.machine->eventDelivered("ffffffff", 2));
}

TEST_CASE("bad_sig и replayed_seq — не чаще раза в 10 с на тип; пропущенные — в data.suppressed") {
  test::Rig rig;
  rig.boot(0);
  for (int i = 0; i < 4; ++i) CHECK(rig.send("ping", bl::Json::object(), 1, otherKey()).get("error")->asString() == "bad_sig");
  auto count = [&](const char* type) {
    int n = 0;
    for (const auto& e : rig.rec.events) n += e.get("type")->asString() == type;
    return n;
  };
  CHECK(count("bad_sig") == 1);
  CHECK(rig.send("ping", bl::Json::object(), 5).get("ok")->asBool());
  rig.send("ping", bl::Json::object(), 1);
  rig.send("ping", bl::Json::object(), 1);
  CHECK(count("replayed_seq") == 1);
  rig.advance(9999);
  rig.send("ping", bl::Json::object(), 1, otherKey());
  CHECK(count("bad_sig") == 1);
  rig.advance(1);
  rig.send("ping", bl::Json::object(), 1, otherKey());
  CHECK(count("bad_sig") == 2);
  const bl::Json& last = rig.rec.events.back();
  CHECK(last.get("data")->dump().find("\"suppressed\":4") != std::string::npos);
}

TEST_CASE("NVS: при связи доставленные события в NVS не пишутся; без связи — пишутся и переживают загрузку") {
  bl::MemoryNvs nvs;
  test::Rig rig(bl::Caps(), &nvs);
  rig.boot(0);
  rig.machine->setOnline(true);
  deliverAll(*rig.machine);
  unsigned before = nvs.writes();
  rig.send("ping", bl::Json::object(), 1, otherKey());
  deliverAll(*rig.machine);
  CHECK(nvs.writes() == before);
  rig.send("ping", bl::Json::object(), 1);
  CHECK(nvs.writes() == before + 1);  // блок replay
  rig.machine->setOnline(false);
  unsigned offline = nvs.writes();
  rig.send("ping", bl::Json::object(), 1, otherKey());  // через 0 мс — подавлено
  rig.advance(10000);
  rig.send("ping", bl::Json::object(), 1);  // replayed_seq без связи
  CHECK(nvs.writes() > offline);
  rig.boot(rig.now);
  auto box = rig.machine->outbox();
  REQUIRE(box.size() == 2);
  CHECK(box[0].type == "replayed_seq");
  CHECK(box[1].type == "boot");
}

TEST_CASE("буфер на 64: вытеснение старого, затем первым уходит events_dropped {count}") {
  test::Rig rig;
  rig.boot(0);
  for (int i = 0; i < 69; ++i) {
    rig.send("ping", bl::Json::object(), 1, otherKey());
    rig.advance(10000);
  }
  auto box = rig.machine->outbox();
  REQUIRE(box.size() == 65);
  CHECK(box[0].type == "events_dropped");
  CHECK(box[0].payload.find("\"data\":{\"count\":6}") != std::string::npos);
  CHECK(box[0].n == 71);
  CHECK(box[1].n == 7);
  CHECK(box.back().n == 70);
  CHECK(rig.machine->outbox().size() == 65);  // events_dropped создаётся один раз
  CHECK(rig.machine->eventDelivered(box[0].bootId, 71));
  CHECK(rig.machine->outbox()[0].n == 7);
}

TEST_CASE("кольцевой буфер: удаление не по порядку, перезагрузка из NVS") {
  bl::MemoryNvs nvs;
  bl::EventRing ring(nvs, 3);
  auto ev = [](int n) {
    bl::EventEntry e;
    REQUIRE(bl::EventEntry::fromPayload("{\"v\":1,\"boot\":1,\"boot_id\":\"aaaaaaaa\",\"n\":" + bl::intToString(n) + ",\"type\":\"t\",\"at_uptime_ms\":0,\"data\":{}}", e));
    return e;
  };
  for (int n = 1; n <= 5; ++n) ring.push(ev(n));
  auto l = ring.list();
  REQUIRE(l.size() == 3);
  CHECK(l[0].n == 3);
  CHECK(ring.dropped() == 2);
  CHECK(nvs.writes() == 0);
  ring.persist();
  CHECK(nvs.writes() > 0);
  CHECK(ring.remove("aaaaaaaa", 4));
  l = ring.list();
  REQUIRE(l.size() == 2);
  CHECK(l[1].n == 5);
  CHECK(ring.takeDropped() == 2);
  CHECK(ring.takeDropped() == 0);
  bl::EventRing reloaded(nvs, 3);
  l = reloaded.list();
  REQUIRE(l.size() == 2);
  CHECK(l[0].n == 3);
  CHECK(l[1].n == 5);
}
