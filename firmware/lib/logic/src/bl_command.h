// Проверка входящей команды — docs/protocol.md §3 и §3.1, шаги 1–2 (bad_format, bad_sig).
// Шаг 3 (seq и id) — bl_replay.h, шаг 4 (тип и тело) — bl_body.h и bl_machine.cpp.
// Та же логика в симуляторе: tools/device-sim/lib/command.mjs.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

#include "bl_crypto.h"
#include "bl_json.h"

namespace bl {

enum class VerifyStatus : uint8_t { Ok, BadFormat, BadSig };

struct VerifyResult {
  VerifyStatus status = VerifyStatus::BadFormat;
  const char* reason = "";
  Json cmd;               // разобранная команда (Ok и BadSig)
  std::string canonical;  // каноническая строка (Ok и BadSig)
  // Что вернуть в ack: после bad_format — null (§4).
  bool hasEcho = false;
  std::string cmdId;
  int64_t seq = 0;
  std::string type;
};

bool isUuid(const std::string& s);  // UUID в нижнем регистре, 8-4-4-4-12

VerifyResult verifyCommand(const uint8_t* data, size_t len, const uint8_t key[32], HmacFn hmac);

}  // namespace bl
