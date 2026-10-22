// Основы платформы: часы, HMAC mbedTLS, причина сброса, boot_id, watchdog, лог, NVS, ключи.
#if __has_include(<esp_random.h>)
#include <esp_random.h>
#endif
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <mbedtls/md.h>
#include <nvs_flash.h>

#include "bl_platform.h"

namespace bl {

int64_t nowMs() { return esp_timer_get_time() / 1000; }

void hmacMbedtls(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t* out) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (mbedtls_md_hmac(info, key, keyLen, msg, msgLen, out) != 0) {
    // Не должно случаться; нулевой MAC никогда не совпадёт с подписью — команда получит bad_sig.
    memset(out, 0, 32);
  }
}

const char* resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_SW: return "sw";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    default: return "unknown";
  }
}

std::string randomBootId(void*) {
  uint32_t r = esp_random();
  uint8_t b[4] = {(uint8_t)(r >> 24), (uint8_t)(r >> 16), (uint8_t)(r >> 8), (uint8_t)r};
  return toHex(b, 4);
}

void watchdogBegin(uint32_t timeoutS) {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t cfg = {};
  cfg.timeout_ms = timeoutS * 1000;
  cfg.idle_core_mask = 0;
  cfg.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) esp_task_wdt_init(&cfg);
#else
  // В Arduino-ESP32 2.x сторож задач уже запущен ядром (5 с); тогда остаётся его время.
  esp_task_wdt_init(timeoutS, true);
#endif
  esp_task_wdt_add(nullptr);  // задача loop()
}

void watchdogFeed() { esp_task_wdt_reset(); }

void logLine(const char* msg, const std::string& fields) {
  Serial.printf("{\"t_ms\":%lld,\"msg\":\"%s\"%s%s}\n", (long long)nowMs(), msg, fields.empty() ? "" : ",", fields.c_str());
}

// ——— NVS ———

bool EspNvs::begin(const char* partition, bool secure) {
  auto init = [&]() -> esp_err_t {
#if CONFIG_NVS_ENCRYPTION
    if (secure) {
      const esp_partition_t* kp = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS_KEYS, nullptr);
      if (kp == nullptr) return ESP_ERR_NOT_FOUND;
      nvs_sec_cfg_t cfg;
      esp_err_t err = nvs_flash_read_security_cfg(kp, &cfg);
      if (err == ESP_ERR_NVS_KEYS_NOT_INITIALIZED || err == ESP_ERR_NVS_CORRUPT_KEY_PART) err = nvs_flash_generate_keys(kp, &cfg);
      if (err != ESP_OK) return err;
      err = nvs_flash_secure_init_partition(partition, &cfg);
      encrypted_ = err == ESP_OK;
      return err;
    }
#else
    (void)secure;
#endif
    return nvs_flash_init_partition(partition);
  };
  esp_err_t err = init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase_partition(partition);
    err = init();
  }
  if (err != ESP_OK) {
    logLine("nvs_init_failed", std::string("\"partition\":\"") + partition + "\",\"err\":" + intToString(err));
    return false;
  }
  if (secure && !encrypted_) {
    // Arduino-ESP32 2.x собран без CONFIG_NVS_ENCRYPTION: ключи не зашифрованы (README, «Безопасность»).
    logLine("nvs_keys_unencrypted", std::string("\"partition\":\"") + partition + "\"");
  }
  ok_ = nvs_open_from_partition(partition, "bl", NVS_READWRITE, &h_) == ESP_OK;
  return ok_;
}

bool EspNvs::get(const std::string& key, std::string& out) {
  if (!ok_) return false;
  size_t len = 0;
  if (nvs_get_blob(h_, key.c_str(), nullptr, &len) != ESP_OK) return false;
  out.assign(len, '\0');
  if (len > 0 && nvs_get_blob(h_, key.c_str(), &out[0], &len) != ESP_OK) return false;
  return true;
}

bool EspNvs::set(const std::string& key, const std::string& value) {
  if (!ok_) return false;
  if (nvs_set_blob(h_, key.c_str(), value.data(), value.size()) != ESP_OK) return false;
  return nvs_commit(h_) == ESP_OK;
}

bool EspNvs::erase(const std::string& key) {
  if (!ok_) return false;
  esp_err_t err = nvs_erase_key(h_, key.c_str());
  if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) return false;
  return nvs_commit(h_) == ESP_OK;
}

bool EspNvs::eraseAll() {
  if (!ok_) return false;
  return nvs_erase_all(h_) == ESP_OK && nvs_commit(h_) == ESP_OK;
}

// ——— Ключи ———

bool KeyStore::begin() { return nvs_.begin("bl_keys", true); }

void KeyStore::load(DeviceKeys& k) {
  nvs_.get("device_id", k.deviceId);
  nvs_.get("claim_code", k.claimCode);
  nvs_.get("wifi_ssid", k.wifiSsid);
  nvs_.get("wifi_pass", k.wifiPass);
  nvs_.get("mqtt_url", k.mqttUrl);
  nvs_.get("mqtt_user", k.mqttUser);
  nvs_.get("mqtt_pass", k.mqttPass);
  nvs_.get("club_id", k.clubId);
  std::string key;
  k.hasDeviceKey = nvs_.get("device_key", key) && key.size() == 32;
  if (k.hasDeviceKey) memcpy(k.deviceKey, key.data(), 32);
}

bool KeyStore::saveFactory(const std::string& deviceId, const std::string& claimCode) {
  return nvs_.set("device_id", deviceId) && nvs_.set("claim_code", claimCode);
}

bool KeyStore::saveWifi(const std::string& ssid, const std::string& pass) {
  return nvs_.set("wifi_ssid", ssid) && nvs_.set("wifi_pass", pass);
}

bool KeyStore::saveClaim(const std::string& mqttUrl, const std::string& user, const std::string& pass, const std::string& clubId,
                         const uint8_t key[32]) {
  return nvs_.set("mqtt_url", mqttUrl) && nvs_.set("mqtt_user", user) && nvs_.set("mqtt_pass", pass) && nvs_.set("club_id", clubId) &&
         nvs_.set("device_key", std::string((const char*)key, 32));
}

void KeyStore::eraseClaim() {
  for (const char* k : {"mqtt_url", "mqtt_user", "mqtt_pass", "club_id", "device_key"}) nvs_.erase(k);
}

void KeyStore::eraseWifi() {
  nvs_.erase("wifi_ssid");
  nvs_.erase("wifi_pass");
}

Topics Topics::of(const std::string& clubId, const std::string& deviceId) {
  std::string p = "bl/v1/" + clubId + "/" + deviceId + "/";
  return Topics{p + "cmd", p + "ack", p + "state", p + "event", p + "status"};
}

}  // namespace bl
