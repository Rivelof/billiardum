#include "bl_claim.h"

#include "bl_command.h"

namespace bl {

bool isClaimCode(const std::string& s) {
  if (s.size() < 8 || s.size() > 63) return false;
  for (char c : s) {
    bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
    if (!ok) return false;
  }
  return true;
}

namespace {

std::string lowerAscii(std::string s) {
  for (char& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

}  // namespace

bool parseFactoryArgs(const std::string& a, const std::string& b, std::string& deviceId, std::string& claimCode) {
  std::string id;
  std::string code;
  const std::string prefix = kClaimQrPrefix;
  if (a.compare(0, prefix.size(), prefix) == 0) {
    if (!b.empty()) return false;
    size_t sep = a.find(':', prefix.size());
    if (sep == std::string::npos) return false;
    id = a.substr(prefix.size(), sep - prefix.size());
    code = a.substr(sep + 1);
  } else {
    id = a;
    code = b;
  }
  id = lowerAscii(id);
  if (!isUuid(id) || !isClaimCode(code)) return false;
  deviceId = id;
  claimCode = code;
  return true;
}

int64_t claimRetryDelayMs(uint32_t failures, const std::string& error) {
  if (error == "bad_request" || error == "http_400") return -1;
  if (error == "rate_limited" || error == "http_429") return kClaimRateLimitedMs;
  int64_t ms = kClaimRetryMinMs;
  for (uint32_t i = 1; i < failures && ms < kClaimRetryMaxMs; ++i) ms *= 2;
  return ms < kClaimRetryMaxMs ? ms : kClaimRetryMaxMs;
}

}  // namespace bl
