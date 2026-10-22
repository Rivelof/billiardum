// Хранилище NVS для логики: запись ключа целиком и атомарно (nvs_set_blob + nvs_commit).
// На ESP32 — раздел данных 64 КБ (lib/platform/src/bl_nvs_esp.cpp), в тестах — MemoryNvs.
// Значения — компактный JSON (как в симуляторе tools/device-sim/lib/nvs.mjs).
#pragma once

#include <map>
#include <string>

namespace bl {

// Ключи NVS (до 15 символов, как в ESP-IDF).
namespace nvs_keys {
constexpr const char* kBoot = "boot";         // счётчик загрузок
constexpr const char* kReplay = "replay";     // {seq, id, ok, error, state_seq} — §3.2, одним блоком
constexpr const char* kSession = "session";   // {session_id, remaining_ms, warn_ms, grace_ms, buzzer, offline_resumes}
constexpr const char* kConfig = "config";     // config.set
constexpr const char* kRingMeta = "ev_meta";  // {head, count, dropped}
constexpr const char* kDropped = "ev_drop";   // недоставленное events_dropped
}  // namespace nvs_keys

class Nvs {
 public:
  virtual ~Nvs() = default;
  virtual bool get(const std::string& key, std::string& out) = 0;
  virtual bool set(const std::string& key, const std::string& value) = 0;
  virtual bool erase(const std::string& key) = 0;
};

class MemoryNvs : public Nvs {
 public:
  bool get(const std::string& key, std::string& out) override {
    auto it = map_.find(key);
    if (it == map_.end()) return false;
    out = it->second;
    return true;
  }
  bool set(const std::string& key, const std::string& value) override {
    map_[key] = value;
    ++writes_;
    return true;
  }
  bool erase(const std::string& key) override {
    if (map_.erase(key) > 0) ++writes_;
    return true;
  }
  unsigned writes() const { return writes_; }
  size_t size() const { return map_.size(); }

 private:
  std::map<std::string, std::string> map_;
  unsigned writes_ = 0;
};

}  // namespace bl
