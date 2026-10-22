// Таблица повторов — docs/protocol.md §3.2. Та же логика: tools/device-sim/lib/replay.mjs.
//
// | Пришло                              | Решение  |
// |-------------------------------------|----------|
// | seq больше сохранённого             | Execute  |
// | seq равен сохранённому, id тот же   | Resend   | не исполнять, отправить сохранённый ack
// | seq равен сохранённому, id другой   | Replayed | replayed_seq и событие
// | seq меньше сохранённого             | Replayed |
#pragma once

#include <cstdint>
#include <string>

#include "bl_json.h"

namespace bl {

struct ReplayRecord {
  bool valid = false;  // блок есть в NVS
  int64_t seq = 0;
  std::string id;
  bool ok = false;
  std::string error;  // пусто при ok
  int64_t stateSeq = 0;

  std::string toJson() const;
  static ReplayRecord fromJson(const std::string& s);
};

enum class ReplayDecision : uint8_t { Execute, Resend, Replayed };

ReplayDecision decideReplay(const ReplayRecord& saved, int64_t seq, const std::string& id);

// ack по §4 — одна функция и для ответа, и для повтора из NVS. cmdId пустой и hasEcho=false → null.
std::string ackPayload(bool hasEcho, const std::string& cmdId, int64_t seq, bool ok, const std::string& error, int64_t stateSeq);
inline std::string ackPayload(const ReplayRecord& r) { return ackPayload(true, r.id, r.seq, r.ok, r.error, r.stateSeq); }

}  // namespace bl
