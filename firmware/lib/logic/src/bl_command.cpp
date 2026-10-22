#include "bl_command.h"

namespace bl {

bool isUuid(const std::string& s) {
  if (s.size() != 36) return false;
  for (size_t i = 0; i < 36; ++i) {
    char c = s[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (c != '-') return false;
    } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return true;
}

namespace {

VerifyResult badFormat(const char* reason) {
  VerifyResult r;
  r.status = VerifyStatus::BadFormat;
  r.reason = reason;
  return r;
}

const char* const kRequired[] = {"v", "id", "seq", "type", "issued_at", "body"};
const char* const kMissing[] = {"missing_v", "missing_id", "missing_seq", "missing_type", "missing_issued_at", "missing_body"};

}  // namespace

VerifyResult verifyCommand(const uint8_t* data, size_t len, const uint8_t key[32], HmacFn hmac) {
  // Шаг 1: размер, строгий JSON, обязательные поля и форматы → bad_format.
  if (len > kMaxCommandBytes) return badFormat("too_large");
  Json msg;
  ParseResult pr = parseJson((const char*)data, len, msg, ParseMode::Strict);
  if (!pr.ok) return badFormat(pr.reason);
  if (!msg.isObject()) return badFormat("not_object");
  for (size_t i = 0; i < sizeof(kRequired) / sizeof(kRequired[0]); ++i) {
    if (!msg.has(kRequired[i])) return badFormat(kMissing[i]);
  }
  const Json* v = msg.get("v");
  const Json* id = msg.get("id");
  const Json* seq = msg.get("seq");
  const Json* type = msg.get("type");
  const Json* issuedAt = msg.get("issued_at");
  const Json* body = msg.get("body");
  if (!v->isInt() || v->asInt() != 1) return badFormat("bad_v");
  if (!id->isString() || !isUuid(id->asString())) return badFormat("bad_id");
  if (!seq->isInt() || seq->asInt() < 1) return badFormat("bad_seq");
  if (!type->isString() || type->asString().empty()) return badFormat("bad_type");
  if (!issuedAt->isInt() || issuedAt->asInt() < 0) return badFormat("bad_issued_at");
  if (!body->isObject()) return badFormat("bad_body_not_object");

  VerifyResult r;
  r.hasEcho = true;
  r.cmdId = id->asString();
  r.seq = seq->asInt();
  r.type = type->asString();
  r.canonical = canonicalize(msg, "sig");

  // Шаг 2: подпись. HMAC считается всегда — время ответа не зависит от того, что пришло.
  uint8_t expected[32];
  hmac(key, 32, (const uint8_t*)r.canonical.data(), r.canonical.size(), expected);
  const Json* sig = msg.get("sig");
  r.cmd = std::move(msg);
  r.status = VerifyStatus::BadSig;
  if (sig == nullptr) {
    r.reason = "missing_sig";
    return r;
  }
  uint8_t given[32];
  sig = r.cmd.get("sig");
  if (!sig->isString() || !decodeSig(sig->asString(), given)) {
    r.reason = "sig_format";
    return r;
  }
  if (!constantTimeEqual(given, expected, 32)) {
    r.reason = "sig_mismatch";
    return r;
  }
  r.status = VerifyStatus::Ok;
  r.reason = "";
  return r;
}

}  // namespace bl
