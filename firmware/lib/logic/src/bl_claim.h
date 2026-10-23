// Привязка контроллера — docs/protocol.md §7, решения №67 и №159. Чистая логика без Arduino:
// разбор заводских данных с наклейки и задержка между попытками POST /api/devices/claim.
// Та же логика в симуляторе: tools/device-sim/lib/claim.mjs. Общие векторы:
// tools/device-sim/test/claim-vectors.json.
#pragma once

#include <cstdint>
#include <string>

namespace bl {

// Префикс строки QR на корпусе: BLD1:{device_id}:{claim_code}.
constexpr const char* kClaimQrPrefix = "BLD1:";

// Код привязки с наклейки: 8…63 символа [A-Za-z0-9-]. Он же пароль точки доступа
// Billiardum-XXXX, а пароль WPA2 — 8…63 печатных символа. Регистр значим.
bool isClaimCode(const std::string& s);

// Разбор аргументов консольной команды factory (решение №159):
//   factory <device_id> <claim_code>
//   factory BLD1:<device_id>:<claim_code>   (строка QR с наклейки, второй аргумент пуст)
// device_id — UUID в любом регистре, сохраняется строчными (протокол: UUID строчными).
bool parseFactoryArgs(const std::string& a, const std::string& b, std::string& deviceId, std::string& claimCode);

// Задержки повтора POST /api/devices/claim, мс.
constexpr int64_t kClaimRetryMinMs = 5000;
constexpr int64_t kClaimRetryMaxMs = 30000;
constexpr int64_t kClaimRateLimitedMs = 60000;

// Задержка перед следующей попыткой после failures неудач подряд (1 — первая неудача).
// error — код из ответа сервера ({"error": …}) или местный: network, bad_response, http_<статус>.
//   bad_request, http_400 — -1: данные с наклейки сервер не примет, автоматического повтора нет
//                           (на портале — кнопка «Подключить» ещё раз);
//   rate_limited, http_429 — 60 с: за NAT клуба лимит по IP общий на все контроллеры;
//   остальное (forbidden — окно не открыто, закрыто или код не тот; сеть; 5xx) —
//   5 с, 10 с, 20 с, далее 30 с.
// Случайная добавка до 20 % — снаружи (esp_random в прошивке), чтобы столы не шли в ногу.
int64_t claimRetryDelayMs(uint32_t failures, const std::string& error);

}  // namespace bl
