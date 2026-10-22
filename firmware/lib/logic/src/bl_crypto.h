// HMAC-SHA256, base64 и сравнение за постоянное время — docs/protocol.md §3.1.
// Переносимая реализация SHA-256 для нативных тестов и как запасная; на ESP32 платформа
// подставляет HMAC из mbedTLS с аппаратным SHA (lib/platform/src/bl_hmac_mbedtls.cpp).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace bl {

// out — 32 байта.
using HmacFn = void (*)(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t* out);

void sha256(const uint8_t* data, size_t len, uint8_t out[32]);
void hmacSha256Portable(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t* out);

// Сравнение без раннего выхода: время не зависит от того, где различие.
bool constantTimeEqual(const uint8_t* a, const uint8_t* b, size_t len);

std::string base64Encode(const uint8_t* data, size_t len);
// Строгое base64 (стандартный алфавит, с `=`, нулевые хвостовые биты). false — не base64.
bool base64DecodeStrict(const std::string& in, std::string& out);
// `sig` §3: ровно 44 символа, base64 от 32 байт с одним `=` в конце.
bool decodeSig(const std::string& in, uint8_t out[32]);

std::string toHex(const uint8_t* data, size_t len);

}  // namespace bl
