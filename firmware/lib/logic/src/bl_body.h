// Тело команды по типу — docs/protocol.md §3.3 («Диапазоны полей тела»), шаг 4 проверки.
// Неизвестный тип → unknown_type; нет поля, не тот тип значения, вне диапазона → bad_body.
// Неизвестные поля тела игнорируются. Та же таблица — tools/device-sim/lib/body.mjs.
#pragma once

#include <cstdint>
#include <string>

#include "bl_json.h"

namespace bl {

enum class CmdType : uint8_t {
  Unknown,
  SessionStart,
  SessionResume,
  SessionExtend,
  SessionStop,
  ServiceStart,
  ServiceStop,
  StateReserved,
  StatePending,
  StateFree,
  Identify,
  ConfigSet,
  OtaStart,
  Ping,
};

CmdType cmdTypeFrom(const std::string& type);
const char* cmdTypeName(CmdType t);

constexpr int64_t kDayMs = 86400000;
constexpr int64_t kDefaultWarn0 = 300000;
constexpr int64_t kDefaultWarn1 = 60000;
constexpr int64_t kDefaultGraceMs = 120000;

struct Body {
  // session.*
  std::string sessionId;
  int64_t remainingMs = 0;
  int64_t warn[2] = {kDefaultWarn0, kDefaultWarn1};
  int64_t graceMs = kDefaultGraceMs;
  bool buzzer = false;
  // session.stop, service.start
  std::string reasonCode;
  // service.start, identify
  int64_t durationMs = 0;
  // state.pending, state.reserved
  int64_t untilMs = 0;
  // config.set — частичное обновление
  bool hasLedBrightness = false, hasCurrentOnMa = false, hasCurrentConfirmMs = false, hasGraceDim = false, hasGraceBlinkS = false;
  int64_t ledBrightness = 0, currentOnMa = 0, currentConfirmMs = 0, graceDim = 0, graceBlinkS = 0;
  // ota.start
  std::string url, version, sha256, imageSig;
};

enum class BodyStatus : uint8_t { Ok, UnknownType, BadBody };

struct BodyResult {
  BodyStatus status = BodyStatus::Ok;
  const char* field = "";  // для лога при bad_body
};

BodyResult validateBody(CmdType type, const Json& body, Body& out);

bool isReasonCode(const std::string& s);  // 1…32 символа [a-z0-9_]

}  // namespace bl
