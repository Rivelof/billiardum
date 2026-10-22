// Обновление прошивки (protocol.md §8): только в free, по одному столу, по явному «да» Андрея.
// 1) esp_https_ota пишет образ во второй раздел приложения (отдельная задача, loop() не блокируется);
// 2) образ читается из флеша обратно: SHA-256 сверяется с `sha256`, подпись `image_sig`
//    (ECDSA P-256 в DER, base64) — с открытым ключом, закреплённым в прошивке;
// 3) esp_https_ota_finish переключает загрузочный раздел; перезагрузка — только когда стол свободен;
// 4) новая прошивка помечается рабочей после подписки на cmd у брокера (ota_ok), иначе через 10 минут
//    или при сбое до этого загрузчик откатывает на прежнюю (ota_failed: rollback после загрузки старой).
// Команда, занимающая стол, прерывает обновление (автомат: ota_failed aborted) и возвращает загрузочный раздел.
#include <esp_https_ota.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <mbedtls/pk.h>

#include <algorithm>
#include <cstring>

#include "bl_platform.h"

#ifndef BL_FW_VERSION
#define BL_FW_VERSION "0.0.0-dev"
#endif

namespace bl {

namespace {
constexpr int64_t kVerifyDeadlineMs = 10 * 60 * 1000;
const char* const kOtaVersionKey = "ota_ver";  // версия, в которую уходим перезагрузкой
}  // namespace

void OtaUpdater::begin(Nvs& state) {
  state_ = &state;
  bootAt_ = nowMs();
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  pendingVerify_ = esp_ota_get_state_partition(running, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
  if (pendingVerify_) logLine("ota_pending_verify", std::string("\"fw\":\"") + BL_FW_VERSION + "\"");
}

void OtaUpdater::start(const Body& b) {
  if (busy_) return;
  body_ = b;
  error_.clear();
  abort_ = false;
  result_ = 0;
  finished_ = false;
  busy_ = true;
  if (xTaskCreatePinnedToCore(&OtaUpdater::task, "bl_ota", 8192, this, 2, nullptr, 0) != pdPASS) {
    error_ = "no_memory";
    busy_ = false;
    result_ = -1;
  }
}

void OtaUpdater::abort() {
  abort_ = true;
  if (finished_) {
    // Образ уже записан и выбран для загрузки — возвращаем текущий раздел.
    esp_ota_set_boot_partition(esp_ota_get_running_partition());
    finished_ = false;
    result_ = 0;
    logLine("ota_aborted_after_download");
  }
}

void OtaUpdater::task(void* self) {
  static_cast<OtaUpdater*>(self)->run();
  vTaskDelete(nullptr);
}

void OtaUpdater::run() {
  auto fail = [&](const char* e) {
    error_ = abort_ ? "aborted" : e;
    busy_ = false;
    result_ = -1;
  };
  esp_http_client_config_t http = {};
  http.url = body_.url.c_str();
  http.cert_pem = caPem_;
  http.timeout_ms = 15000;
  http.keep_alive_enable = true;
  esp_https_ota_config_t cfg = {};
  cfg.http_config = &http;
  esp_https_ota_handle_t h = nullptr;
  if (esp_https_ota_begin(&cfg, &h) != ESP_OK) {
    fail("download");
    return;
  }
  esp_err_t err;
  do {
    err = esp_https_ota_perform(h);
  } while (err == ESP_ERR_HTTPS_OTA_IN_PROGRESS && !abort_);
  if (abort_ || err != ESP_OK || !esp_https_ota_is_complete_data_received(h)) {
    esp_https_ota_abort(h);
    fail("download");
    return;
  }
  int len = esp_https_ota_get_image_len_read(h);
  std::string verifyError;
  if (!verifyImage(esp_ota_get_next_update_partition(nullptr), len, verifyError) || abort_) {
    esp_https_ota_abort(h);
    fail(verifyError.empty() ? "aborted" : verifyError.c_str());
    return;
  }
  if (esp_https_ota_finish(h) != ESP_OK) {
    fail("bad_image");
    return;
  }
  if (abort_) {
    esp_ota_set_boot_partition(esp_ota_get_running_partition());
    fail("aborted");
    return;
  }
  finished_ = true;
  busy_ = false;
  result_ = 1;
}

bool OtaUpdater::verifyImage(const esp_partition_t* part, int len, std::string& error) {
  if (part == nullptr || len <= 0) {
    error = "no_partition";
    return false;
  }
  // SHA-256 образа, уже записанного во флеш.
  uint8_t digest[32];
  mbedtls_md_context_t md;
  mbedtls_md_init(&md);
  bool ok = mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0) == 0 && mbedtls_md_starts(&md) == 0;
  static uint8_t buf[4096];
  for (int off = 0; ok && off < len; off += (int)sizeof(buf)) {
    size_t n = (size_t)std::min<int>((int)sizeof(buf), len - off);
    ok = esp_partition_read(part, (size_t)off, buf, n) == ESP_OK && mbedtls_md_update(&md, buf, n) == 0;
  }
  ok = ok && mbedtls_md_finish(&md, digest) == 0;
  mbedtls_md_free(&md);
  if (!ok) {
    error = "read";
    return false;
  }
  std::string hex = toHex(digest, 32);
  if (!constantTimeEqual((const uint8_t*)hex.data(), (const uint8_t*)body_.sha256.data(), 64)) {
    error = "sha256";
    return false;
  }
  // Подпись образа: ECDSA P-256 над SHA-256, открытый ключ закреплён в прошивке.
  if (pubKeyPem_ == nullptr || pubKeyPem_[0] == '\0') {
    error = "no_ota_key";
    return false;
  }
  std::string sig;
  if (!base64DecodeStrict(body_.imageSig, sig) || sig.empty() || sig.size() > 80) {
    error = "image_sig";
    return false;
  }
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(&pk, (const unsigned char*)pubKeyPem_, strlen(pubKeyPem_) + 1);
  if (rc == 0 && mbedtls_pk_can_do(&pk, MBEDTLS_PK_ECDSA)) {
    rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, (const unsigned char*)sig.data(), sig.size());
  } else {
    rc = -1;
  }
  mbedtls_pk_free(&pk);
  if (rc != 0) {
    error = "image_sig";
    return false;
  }
  return true;
}

void OtaUpdater::poll(Machine& m, int64_t now) {
  if (result_ == -1) {
    result_ = 0;
    m.otaResult(now, false, body_.version, error_);  // после «aborted» автомат уже сообщил сам и это игнорирует
    return;
  }
  if (result_ == 1 && finished_) {
    // Перезагрузка в новую прошивку — только на свободном столе без света.
    if (m.mode() == Mode::Free && !m.relay() && !m.bootWaiting()) {
      state_->set(kOtaVersionKey, body_.version);
      logLine("ota_reboot", "\"version\":\"" + body_.version + "\"");
      delay(200);
      esp_restart();
    }
  }
}

void OtaUpdater::onBrokerReady(Machine& m, int64_t now) {
  std::string target;
  bool updating = state_->get(kOtaVersionKey, target);
  if (pendingVerify_) {
    esp_ota_mark_app_valid_cancel_rollback();
    pendingVerify_ = false;
    state_->erase(kOtaVersionKey);
    m.otaResult(now, true, BL_FW_VERSION, "");
    logLine("ota_valid", std::string("\"fw\":\"") + BL_FW_VERSION + "\"");
  } else if (updating) {
    // Уходили в target, а работает прежняя прошивка — загрузчик откатил обновление.
    state_->erase(kOtaVersionKey);
    if (target != BL_FW_VERSION) m.otaRolledBack(now, target);
  }
}

void OtaUpdater::checkRollbackDeadline(int64_t now) {
  if (pendingVerify_ && now - bootAt_ > kVerifyDeadlineMs) {
    logLine("ota_rollback", "\"reason\":\"no_broker\"");
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}

}  // namespace bl
