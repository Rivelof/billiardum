// Пины и состав платы — из build_flags platformio.ini. Узел с пином -1 отсутствует и не входит в caps
// (protocol.md §1, §4): смена платы меняет только эти числа, логика и протокол те же.
#pragma once

#include "bl_machine.h"

#ifndef BL_PIN_RELAY
#error "BL_PIN_RELAY обязателен: реле — единственный обязательный выход (protocol.md §1)"
#endif
#ifndef BL_RELAY_ACTIVE_HIGH
#define BL_RELAY_ACTIVE_HIGH 1
#endif
#ifndef BL_PIN_LED
#define BL_PIN_LED -1
#endif
#ifndef BL_PIN_BUZZER
#define BL_PIN_BUZZER -1
#endif
#ifndef BL_PIN_CURRENT
#define BL_PIN_CURRENT -1
#endif
#ifndef BL_PIN_DIMMER
#define BL_PIN_DIMMER -1
#endif
#ifndef BL_CT_MA_PER_MV
#define BL_CT_MA_PER_MV 30
#endif

namespace bl {

inline Caps boardCaps() {
  Caps c;
  c.relay = true;
  c.led = BL_PIN_LED >= 0;
  c.buzzer = BL_PIN_BUZZER >= 0;
  c.current = BL_PIN_CURRENT >= 0;
  c.dimmer = BL_PIN_DIMMER >= 0;
  return c;
}

}  // namespace bl
