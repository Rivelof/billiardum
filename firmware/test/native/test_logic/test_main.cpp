// Точка входа нативных тестов логики прошивки (doctest).
// Под PlatformIO (`pio test -e native`, макрос PIO_UNIT_TESTING) — с выводом успешных проверок
// и без кода выхода: так раннер PlatformIO разбирает результаты (docs.platformio.org, Doctest).
#define DOCTEST_CONFIG_IMPLEMENT
#include "doctest.h"

int main(int argc, char** argv) {
  doctest::Context context;
#ifdef PIO_UNIT_TESTING
  context.setOption("success", true);
  context.setOption("no-exitcode", true);
#endif
  context.applyCommandLine(argc, argv);
  return context.run();
}
