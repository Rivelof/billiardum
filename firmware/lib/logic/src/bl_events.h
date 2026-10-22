// Кольцевой буфер событий — docs/protocol.md §4: 64 события, при переполнении вытесняется
// самое старое и растёт счётчик (по нему уходит events_dropped). Буфер живёт в памяти;
// в NVS пишутся только недоставленные — persist() зовётся, когда связи нет.
// Каждый слот — отдельный ключ ev_N. Та же логика: tools/device-sim/lib/nvs.mjs (EventRing).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "bl_nvs.h"

namespace bl {

constexpr int kEventRingCapacity = 64;

struct EventEntry {
  bool used = false;
  int64_t boot = 0;
  std::string bootId;
  int64_t n = 0;
  std::string type;
  std::string payload;  // JSON события целиком

  static bool fromPayload(const std::string& payload, EventEntry& out);
};

class EventRing {
 public:
  EventRing(Nvs& nvs, int capacity = kEventRingCapacity);

  int capacity() const { return capacity_; }
  int dropped() const { return dropped_; }

  void push(const EventEntry& e);
  int takeDropped();
  std::vector<EventEntry> list() const;  // от старого к новому
  void persist();
  bool remove(const std::string& bootId, int64_t n);

 private:
  static std::string slotKey(int idx);
  void clearSlot(int idx);
  void writeMeta();

  Nvs& nvs_;
  int capacity_;
  std::vector<EventEntry> slots_;
  std::vector<bool> persisted_;
  int head_ = 0;
  int count_ = 0;
  int dropped_ = 0;
  bool metaDirty_ = false;
};

}  // namespace bl
