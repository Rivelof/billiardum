// Таблица повторов §3.2 и порядок «исполнить → блок в NVS → ack».
#include <string>
#include <vector>

#include "bl_replay.h"
#include "doctest.h"
#include "support.h"

namespace {

const char* A = "0192f3c1-6d1a-7c3e-9b2a-0000000000a1";
const char* B = "0192f3c1-6d1a-7c3e-9b2a-0000000000b2";

// NVS, которая отмечает запись блока replay в общем журнале порядка выходов.
class OrderNvs : public bl::MemoryNvs {
 public:
  explicit OrderNvs(std::vector<std::string>& order) : order_(order) {}
  bool set(const std::string& key, const std::string& value) override {
    if (key == bl::nvs_keys::kReplay) order_.push_back("nvs:replay");
    return bl::MemoryNvs::set(key, value);
  }

 private:
  std::vector<std::string>& order_;
};

}  // namespace

TEST_CASE("§3.2: решение по seq и id") {
  bl::ReplayRecord none;
  CHECK(bl::decideReplay(none, 1, A) == bl::ReplayDecision::Execute);
  bl::ReplayRecord saved;
  saved.valid = true;
  saved.seq = 5;
  saved.id = A;
  CHECK(bl::decideReplay(saved, 6, B) == bl::ReplayDecision::Execute);
  CHECK(bl::decideReplay(saved, 5, A) == bl::ReplayDecision::Resend);
  CHECK(bl::decideReplay(saved, 5, B) == bl::ReplayDecision::Replayed);
  CHECK(bl::decideReplay(saved, 4, A) == bl::ReplayDecision::Replayed);
  CHECK(bl::decideReplay(saved, 1, B) == bl::ReplayDecision::Replayed);
}

TEST_CASE("§4: ack — одна запись и для ответа, и для повтора из NVS") {
  CHECK(bl::ackPayload(true, A, 6, true, "", 4) == std::string("{\"v\":1,\"cmd_id\":\"") + A + "\",\"seq\":6,\"ok\":true,\"error\":null,\"state_seq\":4}");
  CHECK(bl::ackPayload(false, "", 0, false, "bad_format", 2) == "{\"v\":1,\"cmd_id\":null,\"seq\":null,\"ok\":false,\"error\":\"bad_format\",\"state_seq\":2}");
  bl::ReplayRecord r;
  r.valid = true;
  r.seq = 7;
  r.id = B;
  r.ok = false;
  r.error = "bad_body";
  r.stateSeq = 9;
  bl::ReplayRecord back = bl::ReplayRecord::fromJson(r.toJson());
  CHECK(back.valid);
  CHECK(bl::ackPayload(back) == bl::ackPayload(r));
}

TEST_CASE("§3.2 через автомат: исполнить → NVS → ack; точный повтор без исполнения") {
  std::vector<std::string> order;
  OrderNvs nvs(order);
  test::Rig rig(bl::Caps(), &nvs);
  rig.boot(1000);
  rig.rec.order.clear();
  order.clear();
  std::string raw = test::signCommand(test::kScenarioKeyB64, A, 1, "session.start",
                                      [] {
                                        bl::Json b = bl::Json::object();
                                        b.set("session_id", bl::Json::string("0192f3c0-0000-7000-8000-000000000001"));
                                        b.set("remaining_ms", bl::Json::integer(3600000));
                                        b.set("buzzer", bl::Json::boolean(true));
                                        return b;
                                      }());
  bl::Json ack = rig.sendRaw(raw);
  CHECK(ack.get("ok")->asBool());
  // Порядок: relay (метрика), state, затем запись блока в NVS, затем ack.
  std::vector<std::string> merged;
  for (const auto& o : rig.rec.order) {
    if (o == "ack") merged.push_back("nvs:replay");
    merged.push_back(o);
  }
  CHECK(order == std::vector<std::string>{"nvs:replay"});
  CHECK(rig.rec.order == std::vector<std::string>{"relay", "state", "ack"});
  bl::Json state;
  bl::parseJson(rig.rec.states.back(), state, bl::ParseMode::Relaxed);
  CHECK(ack.get("state_seq")->asInt() == state.get("state_seq")->asInt());

  std::string firstAck = rig.lastAckRaw();
  unsigned writes = nvs.writes();
  size_t states = rig.rec.states.size();
  rig.advance(5000);
  states = rig.rec.states.size();
  rig.sendRaw(raw);
  CHECK(rig.lastAckRaw() == firstAck);
  CHECK(nvs.writes() == writes);
  CHECK(rig.rec.states.size() == states);
  CHECK(rig.state().get("remaining_ms")->asInt() == 3595000);

  // Тот же seq, другой id — replayed_seq; seq меньше — replayed_seq.
  bl::Json other = rig.sendRaw(test::signCommand(test::kScenarioKeyB64, B, 1, "ping", bl::Json::object()));
  CHECK(other.get("error")->asString() == "replayed_seq");
  CHECK(other.get("cmd_id")->asString() == B);
  rig.send("ping", bl::Json::object(), 2);
  bl::Json lower = rig.sendRaw(raw);
  CHECK(lower.get("error")->asString() == "replayed_seq");
  CHECK(rig.machine->lastSeq() == 2);
}

TEST_CASE("§3.1 шаг 4: bad_body и unknown_type сдвигают seq и повторяются тем же ack") {
  test::Rig rig;
  rig.boot(0);
  bl::Json body = bl::Json::object();
  body.set("duration_ms", bl::Json::integer(0));
  bl::Json ack = rig.send("identify", body);
  CHECK(ack.get("error")->asString() == "bad_body");
  CHECK(rig.machine->lastSeq() == 1);
  CHECK(rig.send("lamp.on", bl::Json::object()).get("error")->asString() == "unknown_type");
  CHECK(rig.machine->lastSeq() == 2);
  // bad_sig и bad_format seq не сдвигают.
  rig.send("ping", bl::Json::object(), 3, bl::base64Encode((const uint8_t*)std::string(32, '\x07').data(), 32));
  rig.sendRaw("{\"v\":1");
  CHECK(rig.machine->lastSeq() == 2);
  CHECK(rig.send("ping", bl::Json::object(), 3).get("ok")->asBool());
}
