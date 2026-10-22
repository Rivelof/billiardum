// Строгий JSON §3.1, каноническая строка, SHA-256/HMAC (RFC 4231), base64 и sig.
#include <string>

#include "bl_command.h"
#include "bl_crypto.h"
#include "bl_json.h"
#include "doctest.h"
#include "support.h"

namespace {

std::string reasonOf(const std::string& text) {
  bl::Json j;
  bl::ParseResult r = bl::parseJson(text, j, bl::ParseMode::Strict);
  return r.ok ? "ok" : r.reason;
}

std::string hex(const std::string& s) { return bl::toHex((const uint8_t*)s.data(), s.size()); }

}  // namespace

TEST_CASE("строгий JSON: что принимается") {
  CHECK(reasonOf("{}") == "ok");
  CHECK(reasonOf(" {\"a\" : [1, -2, 0, true, false, null, \"x y\"] }\n") == "ok");
  CHECK(reasonOf("{\"n\":9007199254740991,\"m\":-9007199254740991}") == "ok");
  CHECK(reasonOf("[]") == "ok");
}

TEST_CASE("строгий JSON: bad_format по §3.1") {
  CHECK(reasonOf("{\"a\":\"\\u0069\"}") == "backslash");
  CHECK(reasonOf("{\"a\":\"x\\/y\"}") == "backslash");
  CHECK(reasonOf("{\"a\":1,\"a\":2}") == "duplicate_key");
  CHECK(reasonOf("{\"b\":{\"a\":1,\"a\":1}}") == "duplicate_key");
  CHECK(reasonOf("{\"a\":-0}") == "number_not_integer");
  CHECK(reasonOf("{\"a\":1.0}") == "number_not_integer");
  CHECK(reasonOf("{\"a\":9e5}") == "number_not_integer");
  CHECK(reasonOf("{\"a\":1E+2}") == "number_not_integer");
  CHECK(reasonOf("{\"a\":9007199254740992}") == "number_out_of_range");
  CHECK(reasonOf("{\"a\":-9007199254740992}") == "number_out_of_range");
  CHECK(reasonOf("{\"a\":123456789012345678901234567890}") == "number_out_of_range");
  CHECK(reasonOf("{\"a\":042}") == "json_syntax");
  CHECK(reasonOf("{\"a\":+1}") == "json_syntax");
  CHECK(reasonOf("{\"a\":.5}") == "json_syntax");
  CHECK(reasonOf("{\"a\":1.}") == "json_syntax");
  CHECK(reasonOf("{'a':1}") == "json_syntax");
  CHECK(reasonOf("{\"a\":1,}") == "json_syntax");
  CHECK(reasonOf("{\"a\":1} x") == "json_syntax");
  CHECK(reasonOf("{\"a\":tru}") == "json_syntax");
  CHECK(reasonOf("") == "json_syntax");
  CHECK(reasonOf("{\"a\":\"\x01\"}") == "json_syntax");
  CHECK(reasonOf("{\"a\":\"\xD1\x83\"}") == "string_charset");
  CHECK(reasonOf("{\"\xD1\x83\":1}") == "key_charset");
  CHECK(reasonOf("\xEF\xBB\xBF{}") == "json_syntax");
  CHECK(reasonOf("{\"body\":{\"sig\":1}}") == "nested_sig");
  CHECK(reasonOf("{\"body\":[{\"sig\":1}]}") == "nested_sig");
  CHECK(reasonOf("{\"sig\":1}") == "ok");
  // Вложенность: контейнер на глубине 8 — too_deep (верхний объект — глубина 0).
  CHECK(reasonOf("{\"a\":[[[[[[[1]]]]]]]}") == "ok");
  CHECK(reasonOf("{\"a\":[[[[[[[[1]]]]]]]]}") == "too_deep");
}

TEST_CASE("каноническая строка: ключи по байтам на всех уровнях, без sig верхнего уровня") {
  bl::Json j;
  REQUIRE(bl::parseJson("{\"z\":1,\"b\":{\"y\":[3,{\"d\":1,\"c\":2}],\"a\":null},\"A\":\"x\",\"sig\":\"q\"}", j, bl::ParseMode::Strict).ok);
  CHECK(bl::canonicalize(j, "sig") == "{\"A\":\"x\",\"b\":{\"a\":null,\"y\":[3,{\"c\":2,\"d\":1}]},\"z\":1}");
  CHECK(bl::canonicalize(j, nullptr).find("\"sig\":\"q\"") != std::string::npos);
}

TEST_CASE("SHA-256 и HMAC-SHA256: эталоны FIPS 180 и RFC 4231") {
  uint8_t out[32];
  bl::sha256((const uint8_t*)"abc", 3, out);
  CHECK(bl::toHex(out, 32) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  bl::sha256(nullptr, 0, out);
  CHECK(bl::toHex(out, 32) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  std::string m = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  bl::sha256((const uint8_t*)m.data(), m.size(), out);
  CHECK(bl::toHex(out, 32) == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");

  // RFC 4231, тест 1 и 2, 6 (ключ длиннее блока).
  std::string k1(20, '\x0b');
  bl::hmacSha256Portable((const uint8_t*)k1.data(), k1.size(), (const uint8_t*)"Hi There", 8, out);
  CHECK(bl::toHex(out, 32) == "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  std::string msg2 = "what do ya want for nothing?";
  bl::hmacSha256Portable((const uint8_t*)"Jefe", 4, (const uint8_t*)msg2.data(), msg2.size(), out);
  CHECK(bl::toHex(out, 32) == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  std::string k6(131, '\xaa');
  std::string msg6 = "Test Using Larger Than Block-Size Key - Hash Key First";
  bl::hmacSha256Portable((const uint8_t*)k6.data(), k6.size(), (const uint8_t*)msg6.data(), msg6.size(), out);
  CHECK(bl::toHex(out, 32) == "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
}

TEST_CASE("base64 и sig: строго 44 символа от 32 байт") {
  std::string out;
  CHECK(bl::base64Encode((const uint8_t*)"ab", 2) == "YWI=");
  CHECK(bl::base64DecodeStrict("YWI=", out));
  CHECK(out == "ab");
  CHECK_FALSE(bl::base64DecodeStrict("YWJ=", out));  // ненулевые хвостовые биты
  CHECK_FALSE(bl::base64DecodeStrict("YW=I", out));
  CHECK_FALSE(bl::base64DecodeStrict("YWI", out));
  CHECK_FALSE(bl::base64DecodeStrict("", out));
  uint8_t sig[32];
  CHECK(bl::decodeSig("0adhowuxXzPI0x++bwIXwuXKNS8BI/e071sUq3tkh+o=", sig));
  CHECK_FALSE(bl::decodeSig("0adhowuxXzPI0x++bwIXwuXKNS8BI/e071sUq3tkh+o", sig));
  CHECK_FALSE(bl::decodeSig("0adhowuxXzPI0x++bwIXwuXKNS8BI/e071sUq3tkh+p=", sig));
  CHECK_FALSE(bl::decodeSig("BwcHBwcHBwcHBwcHBwcHBw==", sig));
  CHECK_FALSE(bl::decodeSig("!!not-base64!!", sig));
  CHECK(bl::constantTimeEqual((const uint8_t*)"abc", (const uint8_t*)"abc", 3));
  CHECK_FALSE(bl::constantTimeEqual((const uint8_t*)"abc", (const uint8_t*)"abd", 3));
  CHECK(hex("\x01\xff") == "01ff");
}

TEST_CASE("команда: больше 2048 байт — bad_format; ровно 2048 разбирается") {
  std::string key = test::decodeB64(test::kScenarioKeyB64);
  std::string base = "{\"v\":1,\"id\":\"0192f3c1-6d1a-7c3e-9b2a-000000000001\",\"seq\":1,\"type\":\"ping\",\"issued_at\":1,\"body\":{\"pad\":\"\"}}";
  std::string pad(2048 - base.size(), 'x');
  std::string exact = base;
  exact.insert(exact.find("\"\"}") + 1, pad);
  REQUIRE(exact.size() == 2048);
  bl::VerifyResult r = bl::verifyCommand((const uint8_t*)exact.data(), exact.size(), (const uint8_t*)key.data(), bl::hmacSha256Portable);
  CHECK(r.status == bl::VerifyStatus::BadSig);  // формат верен, подписи нет
  std::string over = exact;
  over.insert(over.find("\"\"}") + 1, "x");
  r = bl::verifyCommand((const uint8_t*)over.data(), over.size(), (const uint8_t*)key.data(), bl::hmacSha256Portable);
  CHECK(r.status == bl::VerifyStatus::BadFormat);
  CHECK(std::string(r.reason) == "too_large");
}

TEST_CASE("UUID в нижнем регистре") {
  CHECK(bl::isUuid("0192f3c1-6d1a-7c3e-9b2a-000000000001"));
  CHECK_FALSE(bl::isUuid("0192F3C1-6D1A-7C3E-9B2A-000000000001"));
  CHECK_FALSE(bl::isUuid("0192f3c16d1a-7c3e-9b2a-000000000001-"));
  CHECK_FALSE(bl::isUuid("cmd-36"));
}
