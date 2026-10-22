#include "bl_events.h"

#include "bl_json.h"

namespace bl {

bool EventEntry::fromPayload(const std::string& payload, EventEntry& out) {
  Json j;
  if (!parseJson(payload, j, ParseMode::Relaxed).ok || !j.isObject()) return false;
  const Json* boot = j.get("boot");
  const Json* bootId = j.get("boot_id");
  const Json* n = j.get("n");
  const Json* type = j.get("type");
  if (!boot || !boot->isInt() || !bootId || !bootId->isString() || !n || !n->isInt() || !type || !type->isString()) return false;
  out.used = true;
  out.boot = boot->asInt();
  out.bootId = bootId->asString();
  out.n = n->asInt();
  out.type = type->asString();
  out.payload = payload;
  return true;
}

EventRing::EventRing(Nvs& nvs, int capacity)
    : nvs_(nvs), capacity_(capacity), slots_((size_t)capacity), persisted_((size_t)capacity, false) {
  std::string metaText;
  if (!nvs_.get(nvs_keys::kRingMeta, metaText)) return;
  Json meta;
  if (!parseJson(metaText, meta, ParseMode::Strict).ok || !meta.isObject()) return;
  const Json* head = meta.get("head");
  const Json* count = meta.get("count");
  const Json* dropped = meta.get("dropped");
  if (!head || !head->isInt() || !count || !count->isInt() || !dropped || !dropped->isInt()) return;
  if (head->asInt() < 0 || head->asInt() >= capacity_ || count->asInt() < 0 || count->asInt() > capacity_) return;
  // После перезагрузки: недоставленные события из NVS. Слот без записи — дыра,
  // событие было в полёте и в NVS не попало.
  head_ = (int)head->asInt();
  count_ = (int)count->asInt();
  dropped_ = (int)dropped->asInt();
  for (int i = 0; i < count_; ++i) {
    int idx = (head_ + i) % capacity_;
    std::string payload;
    EventEntry e;
    if (nvs_.get(slotKey(idx), payload) && EventEntry::fromPayload(payload, e)) {
      slots_[(size_t)idx] = e;
      persisted_[(size_t)idx] = true;
    }
  }
}

std::string EventRing::slotKey(int idx) { return "ev_" + intToString(idx); }

void EventRing::push(const EventEntry& e) {
  if (count_ == capacity_) {
    clearSlot(head_);
    head_ = (head_ + 1) % capacity_;
    count_ -= 1;
    dropped_ += 1;
  }
  int idx = (head_ + count_) % capacity_;
  slots_[(size_t)idx] = e;
  slots_[(size_t)idx].used = true;
  persisted_[(size_t)idx] = false;
  count_ += 1;
  metaDirty_ = true;
}

int EventRing::takeDropped() {
  int n = dropped_;
  if (n > 0) {
    dropped_ = 0;
    metaDirty_ = true;
  }
  return n;
}

std::vector<EventEntry> EventRing::list() const {
  std::vector<EventEntry> out;
  for (int i = 0; i < count_; ++i) {
    const EventEntry& e = slots_[(size_t)((head_ + i) % capacity_)];
    if (e.used) out.push_back(e);
  }
  return out;
}

void EventRing::persist() {
  for (int i = 0; i < count_; ++i) {
    int idx = (head_ + i) % capacity_;
    if (slots_[(size_t)idx].used && !persisted_[(size_t)idx]) {
      nvs_.set(slotKey(idx), slots_[(size_t)idx].payload);
      persisted_[(size_t)idx] = true;
      metaDirty_ = true;
    }
  }
  if (metaDirty_) writeMeta();
}

bool EventRing::remove(const std::string& bootId, int64_t n) {
  int at = -1;
  for (int i = 0; i < count_; ++i) {
    const EventEntry& e = slots_[(size_t)((head_ + i) % capacity_)];
    if (e.used && e.bootId == bootId && e.n == n) {
      at = i;
      break;
    }
  }
  if (at < 0) return false;
  int idx = (head_ + at) % capacity_;
  bool wasPersisted = persisted_[(size_t)idx];
  clearSlot(idx);
  // Снимаем дыры с головы: доставка обычно идёт по порядку.
  while (count_ > 0 && !slots_[(size_t)head_].used) {
    head_ = (head_ + 1) % capacity_;
    count_ -= 1;
  }
  if (count_ == 0) head_ = 0;
  metaDirty_ = true;
  if (wasPersisted) writeMeta();
  return true;
}

void EventRing::clearSlot(int idx) {
  if (persisted_[(size_t)idx]) nvs_.erase(slotKey(idx));
  slots_[(size_t)idx] = EventEntry();
  persisted_[(size_t)idx] = false;
}

void EventRing::writeMeta() {
  Json meta = Json::object();
  meta.set("head", Json::integer(head_));
  meta.set("count", Json::integer(count_));
  meta.set("dropped", Json::integer(dropped_));
  nvs_.set(nvs_keys::kRingMeta, meta.dump());
  metaDirty_ = false;
}

}  // namespace bl
