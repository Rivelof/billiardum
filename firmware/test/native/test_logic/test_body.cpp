// Диапазоны полей тела §3.3 (bad_body), умолчания, unknown_type — те же случаи, что в
// tools/device-sim/test/machine.test.mjs («bad_body: нет поля…»).
#include <string>

#include "bl_body.h"
#include "doctest.h"

namespace {

const char* S = "0192f3c0-0000-7000-8000-000000000001";
const char* SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

bl::Json body(const std::string& text) {
  bl::Json j;
  REQUIRE(bl::parseJson(text, j, bl::ParseMode::Strict).ok);
  return j;
}

std::string check(const char* type, const std::string& text) {
  bl::Body b;
  bl::BodyResult r = bl::validateBody(bl::cmdTypeFrom(type), body(text), b);
  if (r.status == bl::BodyStatus::Ok) return "ok";
  if (r.status == bl::BodyStatus::UnknownType) return "unknown_type";
  return std::string("bad_body:") + r.field;
}

std::string sid() { return std::string("\"session_id\":\"") + S + "\""; }

}  // namespace

TEST_CASE("§3.3: диапазоны и обязательные поля") {
  struct Case {
    const char* type;
    std::string body;
    const char* want;
  };
  const Case cases[] = {
      {"session.start", "{" + sid() + ",\"remaining_ms\":60000}", "bad_body:buzzer"},
      {"session.start", "{\"session_id\":\"0192F3C0-0000-7000-8000-000000000001\",\"remaining_ms\":60000,\"buzzer\":true}", "bad_body:session_id"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":0,\"buzzer\":true}", "bad_body:remaining_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true}", "ok"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":86400000,\"buzzer\":true}", "ok"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":86400001,\"buzzer\":true}", "bad_body:remaining_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":1}", "bad_body:buzzer"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"warn_ms\":[60000,300000]}", "bad_body:warn_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"warn_ms\":[300000]}", "bad_body:warn_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"warn_ms\":[3600001,1]}", "bad_body:warn_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"warn_ms\":[3600000,1]}", "ok"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"warn_ms\":[2,2]}", "bad_body:warn_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"warn_ms\":[2,0]}", "bad_body:warn_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"warn_ms\":[\"2\",1]}", "bad_body:warn_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"grace_ms\":600001}", "bad_body:grace_ms"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"grace_ms\":0}", "ok"},
      {"session.start", "{" + sid() + ",\"remaining_ms\":1,\"buzzer\":true,\"grace_ms\":null}", "bad_body:grace_ms"},
      {"session.resume", "{\"remaining_ms\":1,\"buzzer\":true}", "bad_body:session_id"},
      {"session.extend", "{" + sid() + ",\"buzzer\":true}", "bad_body:remaining_ms"},
      {"session.stop", "{" + sid() + "}", "bad_body:reason_code"},
      {"session.stop", "{" + sid() + ",\"reason_code\":\"\"}", "bad_body:reason_code"},
      {"session.stop", "{" + sid() + ",\"reason_code\":\"Guest\"}", "bad_body:reason_code"},
      {"session.stop", "{" + sid() + ",\"reason_code\":\"a-b\"}", "bad_body:reason_code"},
      {"session.stop", "{" + sid() + ",\"reason_code\":\"a b\"}", "bad_body:reason_code"},
      {"session.stop", "{" + sid() + ",\"reason_code\":\"" + std::string(33, 'a') + "\"}", "bad_body:reason_code"},
      {"session.stop", "{" + sid() + ",\"reason_code\":\"" + std::string(32, 'a') + "\"}", "ok"},
      {"session.stop", "{" + sid() + ",\"reason_code\":\"guest_finished_2\"}", "ok"},
      {"service.start", "{\"reason_code\":\"cleaning\"}", "bad_body:duration_ms"},
      {"service.start", "{\"duration_ms\":0,\"reason_code\":\"cleaning\"}", "bad_body:duration_ms"},
      {"service.start", "{\"duration_ms\":86400001,\"reason_code\":\"cleaning\"}", "bad_body:duration_ms"},
      {"service.start", "{\"duration_ms\":1,\"reason_code\":\"z_9\"}", "ok"},
      {"state.pending", "{\"until_ms\":-1}", "bad_body:until_ms"},
      {"state.pending", "{\"until_ms\":86400000}", "ok"},
      {"state.reserved", "{}", "bad_body:until_ms"},
      {"state.reserved", "{\"until_ms\":86400001}", "bad_body:until_ms"},
      {"identify", "{\"duration_ms\":0}", "bad_body:duration_ms"},
      {"identify", "{\"duration_ms\":\"5\"}", "bad_body:duration_ms"},
      {"identify", "{\"duration_ms\":30000,\"extra\":null}", "ok"},
      {"config.set", "{}", "ok"},
      {"config.set", "{\"led_brightness\":256}", "bad_body:led_brightness"},
      {"config.set", "{\"led_brightness\":-1}", "bad_body:led_brightness"},
      {"config.set", "{\"current_on_ma\":0}", "bad_body:current_on_ma"},
      {"config.set", "{\"current_on_ma\":100001}", "bad_body:current_on_ma"},
      {"config.set", "{\"current_confirm_ms\":600001}", "bad_body:current_confirm_ms"},
      {"config.set", "{\"grace_dim\":101}", "bad_body:grace_dim"},
      {"config.set", "{\"grace_blink_s\":0}", "bad_body:grace_blink_s"},
      {"config.set", "{\"grace_blink_s\":3601}", "bad_body:grace_blink_s"},
      {"config.set", "{\"led_brightness\":0,\"current_on_ma\":100000,\"current_confirm_ms\":600000,\"grace_dim\":0,\"grace_blink_s\":3600}", "ok"},
      {"ota.start", std::string("{\"url\":\"http://billiardum.ru/fw.bin\",\"version\":\"1\",\"sha256\":\"") + SHA + "\",\"image_sig\":\"AA==\"}", "bad_body:url"},
      {"ota.start", std::string("{\"url\":\"https:///fw.bin\",\"version\":\"1\",\"sha256\":\"") + SHA + "\",\"image_sig\":\"AA==\"}", "bad_body:url"},
      {"ota.start", std::string("{\"url\":\"https://\",\"version\":\"1\",\"sha256\":\"") + SHA + "\",\"image_sig\":\"AA==\"}", "bad_body:url"},
      {"ota.start", std::string("{\"url\":\"https://a b/\",\"version\":\"1\",\"sha256\":\"") + SHA + "\",\"image_sig\":\"AA==\"}", "bad_body:url"},
      {"ota.start", std::string("{\"url\":\"https://billiardum.ru\",\"version\":\"1\",\"sha256\":\"") + SHA + "\",\"image_sig\":\"AA==\"}", "ok"},
      {"ota.start", "{\"url\":\"https://billiardum.ru/fw.bin\",\"version\":\"1\",\"sha256\":\"00\",\"image_sig\":\"AA==\"}", "bad_body:sha256"},
      {"ota.start", "{\"url\":\"https://billiardum.ru/fw.bin\",\"version\":\"1\",\"sha256\":\"E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855\",\"image_sig\":\"AA==\"}", "bad_body:sha256"},
      {"ota.start", std::string("{\"url\":\"https://billiardum.ru/fw.bin\",\"version\":\"\",\"sha256\":\"") + SHA + "\",\"image_sig\":\"AA==\"}", "bad_body:version"},
      {"ota.start", std::string("{\"url\":\"https://billiardum.ru/fw.bin\",\"version\":\"1\",\"sha256\":\"") + SHA + "\"}", "bad_body:image_sig"},
      {"ping", "{\"anything\":[1]}", "ok"},
      {"lamp.on", "{}", "unknown_type"},
      {"", "{}", "unknown_type"},
  };
  for (const auto& c : cases) {
    INFO(c.type << " " << c.body);
    CHECK(check(c.type, c.body) == c.want);
  }
}

TEST_CASE("§3.3: умолчания warn_ms, grace_ms и разбор полей") {
  bl::Body b;
  REQUIRE(bl::validateBody(bl::CmdType::SessionStart, body("{" + sid() + ",\"remaining_ms\":7200000,\"buzzer\":true,\"extra\":\"x\"}"), b).status ==
          bl::BodyStatus::Ok);
  CHECK(b.sessionId == S);
  CHECK(b.remainingMs == 7200000);
  CHECK(b.warn[0] == 300000);
  CHECK(b.warn[1] == 60000);
  CHECK(b.graceMs == 120000);
  CHECK(b.buzzer);
  REQUIRE(bl::validateBody(bl::CmdType::ConfigSet, body("{\"grace_dim\":0}"), b).status == bl::BodyStatus::Ok);
  CHECK(b.hasGraceDim);
  CHECK_FALSE(b.hasLedBrightness);
  CHECK(bl::isReasonCode("cleaning"));
  CHECK_FALSE(bl::isReasonCode("уборка"));
  CHECK(std::string(bl::cmdTypeName(bl::CmdType::StateReserved)) == "state.reserved");
}
