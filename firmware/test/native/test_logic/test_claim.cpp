// Привязка (§7, решение №159): разбор заводских данных и задержки повтора claim —
// по общим векторам tools/device-sim/test/claim-vectors.json (их же проходит симулятор).
#include <string>

#include "bl_claim.h"
#include "doctest.h"
#include "support.h"

namespace {

bl::Json vectors() { return test::readJsonFile(test::repoRoot() + "/tools/device-sim/test/claim-vectors.json"); }

}  // namespace

TEST_CASE("claim: векторы factory — консольная команда и строка QR BLD1") {
  bl::Json file = vectors();
  REQUIRE(file.isObject());
  const auto& cases = file.get("factory")->items();
  REQUIRE(cases.size() >= 20);
  for (const auto& v : cases) {
    const std::string& name = v.get("name")->asString();
    const auto& args = v.get("args")->items();
    std::string a = args.size() > 0 ? args[0].asString() : "";
    std::string b = args.size() > 1 ? args[1].asString() : "";
    REQUIRE(args.size() <= 2);
    std::string id = "unchanged", code = "unchanged";
    bool ok = bl::parseFactoryArgs(a, b, id, code);
    INFO("вектор «" << name << "»");
    CHECK(ok == v.get("ok")->asBool());
    if (v.get("ok")->asBool()) {
      CHECK(id == v.get("device_id")->asString());
      CHECK(code == v.get("claim_code")->asString());
    } else {
      CHECK(id == "unchanged");
      CHECK(code == "unchanged");
    }
  }
}

TEST_CASE("claim: векторы retry — задержки повтора POST /api/devices/claim") {
  bl::Json file = vectors();
  for (const auto& v : file.get("retry")->items()) {
    const std::string& error = v.get("error")->asString();
    auto failures = static_cast<uint32_t>(v.get("failures")->asInt());
    INFO("error=" << error << " failures=" << failures);
    CHECK(bl::claimRetryDelayMs(failures, error) == v.get("ms")->asInt());
  }
}

TEST_CASE("claim: код привязки — пароль точки доступа WPA2") {
  CHECK(bl::isClaimCode("ABCDEFGH"));
  CHECK_FALSE(bl::isClaimCode(""));
  CHECK_FALSE(bl::isClaimCode(std::string(64, 'A')));
  CHECK(bl::isClaimCode(std::string(63, 'A')));
  CHECK_FALSE(bl::isClaimCode(std::string("ABCD\0EFGH", 9)));
  CHECK(bl::claimRetryDelayMs(UINT32_MAX, "forbidden") == bl::kClaimRetryMaxMs);
}
