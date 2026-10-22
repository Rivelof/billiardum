// Все векторы docs/protocol-vectors.json: результат проверки, каноническая строка, подпись,
// и проход вектора через автомат до ack (как test/vectors.test.mjs симулятора).
#include <string>

#include "bl_command.h"
#include "doctest.h"
#include "support.h"

TEST_CASE("векторы протокола: файл на месте, 38 векторов трёх видов") {
  bl::Json file = test::readJsonFile(test::repoRoot() + "/docs/protocol-vectors.json");
  REQUIRE(file.isObject());
  CHECK(file.get("protocol")->asString() == "bl/v1");
  const auto& vectors = file.get("vectors")->items();
  CHECK(vectors.size() == 38);
  int ok = 0, badSig = 0, badFormat = 0;
  for (const auto& v : vectors) {
    const std::string& e = v.get("expect")->asString();
    ok += e == "ok";
    badSig += e == "bad_sig";
    badFormat += e == "bad_format";
  }
  CHECK(ok + badSig + badFormat == (int)vectors.size());
  CHECK(ok > 0);
  CHECK(badSig > 0);
  CHECK(badFormat > 0);
}

TEST_CASE("векторы протокола: verifyCommand, каноническая строка и подпись") {
  bl::Json file = test::readJsonFile(test::repoRoot() + "/docs/protocol-vectors.json");
  for (const auto& v : file.get("vectors")->items()) {
    const std::string& name = v.get("name")->asString();
    const std::string& raw = v.get("raw")->asString();
    const std::string& expect = v.get("expect")->asString();
    std::string key = test::decodeB64(v.get("key_b64")->asString());
    REQUIRE(key.size() == 32);
    bl::VerifyResult r = bl::verifyCommand((const uint8_t*)raw.data(), raw.size(), (const uint8_t*)key.data(), bl::hmacSha256Portable);
    std::string got = r.status == bl::VerifyStatus::Ok ? "ok" : r.status == bl::VerifyStatus::BadSig ? "bad_sig" : "bad_format";
    INFO("вектор «" << name << "», причина " << r.reason);
    CHECK(got == expect);
    if (expect == "ok" || expect == "bad_sig") {
      CHECK(r.canonical == v.get("canonical")->asString());
    }
    if (expect == "ok") {
      uint8_t mac[32];
      bl::hmacSha256Portable((const uint8_t*)key.data(), 32, (const uint8_t*)r.canonical.data(), r.canonical.size(), mac);
      CHECK(bl::base64Encode(mac, 32) == v.get("sig")->asString());
    }
    if (expect == "bad_format") {
      CHECK_FALSE(r.hasEcho);
    }
  }
}

TEST_CASE("векторы протокола через автомат: ack") {
  bl::Json file = test::readJsonFile(test::repoRoot() + "/docs/protocol-vectors.json");
  for (const auto& v : file.get("vectors")->items()) {
    const std::string& name = v.get("name")->asString();
    const std::string& raw = v.get("raw")->asString();
    const std::string& expect = v.get("expect")->asString();
    test::Rig rig(bl::Caps(), nullptr, v.get("key_b64")->asString());
    rig.boot(0);
    bl::Json ack = rig.sendRaw(raw);
    INFO("вектор «" << name << "»");
    REQUIRE(ack.isObject());
    std::string got = ack.get("ok")->asBool() ? "ok" : ack.get("error")->asString();
    if (expect == "ok") {
      bl::Json cmd;
      bl::parseJson(raw, cmd, bl::ParseMode::Relaxed);
      const std::string& type = cmd.get("type")->asString();
      // На свежем контроллере без сессии extend и stop — wrong_session (как в симуляторе).
      std::string want = (type == "session.extend" || type == "session.stop") ? "wrong_session" : "ok";
      CHECK(got == want);
    } else {
      CHECK(got == expect);
      if (expect == "bad_format") {
        CHECK(ack.get("cmd_id")->isNull());
        CHECK(ack.get("seq")->isNull());
      }
    }
  }
}
