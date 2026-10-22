#include "bl_body.h"

#include <cstring>

#include "bl_command.h"

namespace bl {

namespace {

struct TypeName {
  CmdType type;
  const char* name;
};

const TypeName kTypes[] = {
    {CmdType::SessionStart, "session.start"}, {CmdType::SessionResume, "session.resume"},
    {CmdType::SessionExtend, "session.extend"}, {CmdType::SessionStop, "session.stop"},
    {CmdType::ServiceStart, "service.start"}, {CmdType::ServiceStop, "service.stop"},
    {CmdType::StateReserved, "state.reserved"}, {CmdType::StatePending, "state.pending"},
    {CmdType::StateFree, "state.free"}, {CmdType::Identify, "identify"},
    {CmdType::ConfigSet, "config.set"}, {CmdType::OtaStart, "ota.start"},
    {CmdType::Ping, "ping"},
};

// Проверка одного поля. required=false и поля нет — ок, значение не меняется.
class Fields {
 public:
  explicit Fields(const Json& body) : body_(body) {}

  bool intField(const char* name, bool required, int64_t min, int64_t max, int64_t& out, bool* present = nullptr) {
    const Json* v = body_.get(name);
    if (present) *present = v != nullptr;
    if (v == nullptr) return required ? fail(name) : true;
    if (!v->isInt() || v->asInt() < min || v->asInt() > max) return fail(name);
    out = v->asInt();
    return true;
  }

  bool boolField(const char* name, bool& out) {
    const Json* v = body_.get(name);
    if (v == nullptr || !v->isBool()) return fail(name);
    out = v->asBool();
    return true;
  }

  bool uuidField(const char* name, std::string& out) {
    const Json* v = body_.get(name);
    if (v == nullptr || !v->isString() || !isUuid(v->asString())) return fail(name);
    out = v->asString();
    return true;
  }

  bool reasonField(const char* name, std::string& out) {
    const Json* v = body_.get(name);
    if (v == nullptr || !v->isString() || !isReasonCode(v->asString())) return fail(name);
    out = v->asString();
    return true;
  }

  bool textField(const char* name, std::string& out) {
    const Json* v = body_.get(name);
    if (v == nullptr || !v->isString() || v->asString().empty()) return fail(name);
    out = v->asString();
    return true;
  }

  bool httpsField(const char* name, std::string& out) {
    const Json* v = body_.get(name);
    if (v == nullptr || !v->isString()) return fail(name);
    const std::string& s = v->asString();
    // ^https://[^/\s]+(/\S*)?$ — строки уже печатный ASCII, из пробельных возможен только пробел.
    if (s.compare(0, 8, "https://") != 0 || s.size() == 8 || s[8] == '/') return fail(name);
    if (s.find(' ') != std::string::npos) return fail(name);
    out = s;
    return true;
  }

  bool sha256Field(const char* name, std::string& out) {
    const Json* v = body_.get(name);
    if (v == nullptr || !v->isString() || v->asString().size() != 64) return fail(name);
    for (char c : v->asString()) {
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return fail(name);
    }
    out = v->asString();
    return true;
  }

  // warn_ms: ровно 2 целых по убыванию, каждое 1…3 600 000; по умолчанию [300000, 60000].
  bool warnField(int64_t out[2]) {
    const Json* v = body_.get("warn_ms");
    if (v == nullptr) return true;
    if (!v->isArray() || v->items().size() != 2) return fail("warn_ms");
    for (const auto& item : v->items()) {
      if (!item.isInt() || item.asInt() < 1 || item.asInt() > 3600000) return fail("warn_ms");
    }
    if (v->items()[0].asInt() <= v->items()[1].asInt()) return fail("warn_ms");
    out[0] = v->items()[0].asInt();
    out[1] = v->items()[1].asInt();
    return true;
  }

  const char* field = "";

 private:
  bool fail(const char* name) {
    field = name;
    return false;
  }
  const Json& body_;
};

}  // namespace

CmdType cmdTypeFrom(const std::string& type) {
  for (const auto& t : kTypes) {
    if (type == t.name) return t.type;
  }
  return CmdType::Unknown;
}

const char* cmdTypeName(CmdType type) {
  for (const auto& t : kTypes) {
    if (type == t.type) return t.name;
  }
  return "unknown";
}

bool isReasonCode(const std::string& s) {
  if (s.empty() || s.size() > 32) return false;
  for (char c : s) {
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
  }
  return true;
}

BodyResult validateBody(CmdType type, const Json& body, Body& out) {
  out = Body();
  Fields f(body);
  bool ok = true;
  switch (type) {
    case CmdType::Unknown:
      return BodyResult{BodyStatus::UnknownType, ""};
    case CmdType::SessionStart:
    case CmdType::SessionResume:
      ok = f.uuidField("session_id", out.sessionId) && f.intField("remaining_ms", true, 1, kDayMs, out.remainingMs) &&
           f.warnField(out.warn) && f.intField("grace_ms", false, 0, 600000, out.graceMs) && f.boolField("buzzer", out.buzzer);
      break;
    case CmdType::SessionExtend:
      ok = f.uuidField("session_id", out.sessionId) && f.intField("remaining_ms", true, 1, kDayMs, out.remainingMs) &&
           f.boolField("buzzer", out.buzzer);
      break;
    case CmdType::SessionStop:
      ok = f.uuidField("session_id", out.sessionId) && f.reasonField("reason_code", out.reasonCode);
      break;
    case CmdType::ServiceStart:
      ok = f.intField("duration_ms", true, 1, kDayMs, out.durationMs) && f.reasonField("reason_code", out.reasonCode);
      break;
    case CmdType::StateReserved:
    case CmdType::StatePending:
      ok = f.intField("until_ms", true, 1, kDayMs, out.untilMs);
      break;
    case CmdType::Identify:
      ok = f.intField("duration_ms", true, 1, kDayMs, out.durationMs);
      break;
    case CmdType::ConfigSet:
      ok = f.intField("led_brightness", false, 0, 255, out.ledBrightness, &out.hasLedBrightness) &&
           f.intField("current_on_ma", false, 1, 100000, out.currentOnMa, &out.hasCurrentOnMa) &&
           f.intField("current_confirm_ms", false, 1, 600000, out.currentConfirmMs, &out.hasCurrentConfirmMs) &&
           f.intField("grace_dim", false, 0, 100, out.graceDim, &out.hasGraceDim) &&
           f.intField("grace_blink_s", false, 1, 3600, out.graceBlinkS, &out.hasGraceBlinkS);
      break;
    case CmdType::OtaStart:
      ok = f.httpsField("url", out.url) && f.textField("version", out.version) && f.sha256Field("sha256", out.sha256) &&
           f.textField("image_sig", out.imageSig);
      break;
    case CmdType::ServiceStop:
    case CmdType::StateFree:
    case CmdType::Ping:
      break;
  }
  if (!ok) return BodyResult{BodyStatus::BadBody, f.field};
  return BodyResult{BodyStatus::Ok, ""};
}

}  // namespace bl
