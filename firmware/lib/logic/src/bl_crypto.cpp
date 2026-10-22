#include "bl_crypto.h"

#include <cstring>

namespace bl {

namespace {

const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

struct Sha256 {
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  uint8_t buf[64];
  size_t bufLen = 0;
  uint64_t total = 0;

  void block(const uint8_t* p) {
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
      w[i] = ((uint32_t)p[4 * i] << 24) | ((uint32_t)p[4 * i + 1] << 16) | ((uint32_t)p[4 * i + 2] << 8) | (uint32_t)p[4 * i + 3];
    }
    for (int i = 16; i < 64; ++i) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = hh + S1 + ch + K[i] + w[i];
      uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }

  void update(const uint8_t* data, size_t len) {
    total += len;
    while (len > 0) {
      size_t take = 64 - bufLen;
      if (take > len) take = len;
      std::memcpy(buf + bufLen, data, take);
      bufLen += take;
      data += take;
      len -= take;
      if (bufLen == 64) {
        block(buf);
        bufLen = 0;
      }
    }
  }

  void finish(uint8_t out[32]) {
    uint64_t bits = total * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0;
    while (bufLen != 56) update(&zero, 1);
    uint8_t len[8];
    for (int i = 0; i < 8; ++i) len[i] = (uint8_t)(bits >> (56 - 8 * i));
    update(len, 8);
    for (int i = 0; i < 8; ++i) {
      out[4 * i] = (uint8_t)(h[i] >> 24);
      out[4 * i + 1] = (uint8_t)(h[i] >> 16);
      out[4 * i + 2] = (uint8_t)(h[i] >> 8);
      out[4 * i + 3] = (uint8_t)h[i];
    }
  }
};

const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int b64val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

}  // namespace

void sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
  Sha256 s;
  s.update(data, len);
  s.finish(out);
}

void hmacSha256Portable(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t* out) {
  uint8_t k[64] = {0};
  if (keyLen > 64) {
    sha256(key, keyLen, k);
  } else {
    std::memcpy(k, key, keyLen);
  }
  uint8_t ipad[64], opad[64];
  for (int i = 0; i < 64; ++i) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  uint8_t inner[32];
  Sha256 a;
  a.update(ipad, 64);
  a.update(msg, msgLen);
  a.finish(inner);
  Sha256 b;
  b.update(opad, 64);
  b.update(inner, 32);
  b.finish(out);
}

bool constantTimeEqual(const uint8_t* a, const uint8_t* b, size_t len) {
  volatile uint8_t diff = 0;
  for (size_t i = 0; i < len; ++i) diff = (uint8_t)(diff | (a[i] ^ b[i]));
  return diff == 0;
}

std::string base64Encode(const uint8_t* data, size_t len) {
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < len; i += 3) {
    uint32_t v = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8) | data[i + 2];
    out.push_back(kB64[(v >> 18) & 63]);
    out.push_back(kB64[(v >> 12) & 63]);
    out.push_back(kB64[(v >> 6) & 63]);
    out.push_back(kB64[v & 63]);
  }
  if (i + 1 == len) {
    uint32_t v = (uint32_t)data[i] << 16;
    out.push_back(kB64[(v >> 18) & 63]);
    out.push_back(kB64[(v >> 12) & 63]);
    out += "==";
  } else if (i + 2 == len) {
    uint32_t v = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8);
    out.push_back(kB64[(v >> 18) & 63]);
    out.push_back(kB64[(v >> 12) & 63]);
    out.push_back(kB64[(v >> 6) & 63]);
    out.push_back('=');
  }
  return out;
}

bool base64DecodeStrict(const std::string& in, std::string& out) {
  out.clear();
  if (in.empty() || in.size() % 4 != 0) return false;
  size_t pad = 0;
  if (in[in.size() - 1] == '=') pad = (in[in.size() - 2] == '=') ? 2 : 1;
  for (size_t i = 0; i < in.size() - pad; ++i) {
    if (b64val(in[i]) < 0) return false;
  }
  for (size_t i = 0; i < in.size(); i += 4) {
    bool last = i + 4 == in.size();
    int a = b64val(in[i]), b = b64val(in[i + 1]);
    int c = (last && pad == 2) ? 0 : b64val(in[i + 2]);
    int d = (last && pad >= 1) ? 0 : b64val(in[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return false;
    uint32_t v = ((uint32_t)a << 18) | ((uint32_t)b << 12) | ((uint32_t)c << 6) | (uint32_t)d;
    out.push_back((char)(v >> 16));
    if (!(last && pad == 2)) out.push_back((char)((v >> 8) & 0xFF));
    if (!(last && pad >= 1)) out.push_back((char)(v & 0xFF));
    // Неканонические хвостовые биты (например «AB==») — не base64 для нас.
    if (last && pad == 2 && (b & 0x0F) != 0) return false;
    if (last && pad == 1 && (c & 0x03) != 0) return false;
  }
  return true;
}

bool decodeSig(const std::string& in, uint8_t out[32]) {
  if (in.size() != 44 || in[43] != '=') return false;
  for (size_t i = 0; i < 43; ++i) {
    if (b64val(in[i]) < 0) return false;
  }
  std::string bytes;
  if (!base64DecodeStrict(in, bytes) || bytes.size() != 32) return false;
  std::memcpy(out, bytes.data(), 32);
  return true;
}

std::string toHex(const uint8_t* data, size_t len) {
  static const char hex[] = "0123456789abcdef";
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; ++i) {
    out.push_back(hex[data[i] >> 4]);
    out.push_back(hex[data[i] & 15]);
  }
  return out;
}

}  // namespace bl
