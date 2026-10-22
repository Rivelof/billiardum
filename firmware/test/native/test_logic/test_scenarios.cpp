// Общие сценарии tools/device-sim/scenarios/*.json — те же прогоняет симулятор
// (tools/device-sim/test/scenarios.test.mjs). Расхождение прошивки и симулятора — дефект.
#include <string>

#include "doctest.h"
#include "support.h"

TEST_CASE("общие сценарии симулятора и прошивки") {
  std::string dir = test::repoRoot() + "/tools/device-sim/scenarios";
  auto files = test::listJson(dir);
  CHECK(files.size() >= 18);
  for (const auto& f : files) {
    bl::Json scenario = test::readJsonFile(dir + "/" + f);
    REQUIRE_MESSAGE(scenario.isObject(), f);
    auto failures = test::runScenario(scenario);
    std::string text;
    for (const auto& x : failures) text += "\n  " + x;
    CHECK_MESSAGE(failures.empty(), f << ": " << scenario.get("name")->asString() << text);
  }
}

TEST_CASE("исполнитель сценариев ловит расхождения") {
  bl::Json s;
  REQUIRE(bl::parseJson(
              "{\"name\":\"порча\",\"steps\":[{\"cmd\":\"session.start\",\"body\":{\"session_id\":\"0192f3c0-0000-7000-8000-000000000001\","
              "\"remaining_ms\":600000,\"buzzer\":true}},{\"expect\":{\"mode\":\"ending\",\"lamp\":false,\"signals\":{\"warn\":1}}},"
              "{\"cmd\":\"ping\",\"ack\":\"bad_body\"},{\"events\":[\"boot\",\"boot\"]}]}",
              s, bl::ParseMode::Relaxed)
              .ok);
  auto failures = test::runScenario(s);
  CHECK(failures.size() == 5);
}
