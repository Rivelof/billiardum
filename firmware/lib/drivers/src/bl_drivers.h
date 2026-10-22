// Драйверы узлов стола (protocol.md §1): relay, led (WS2812), buzzer, current (трансформатор тока), dimmer.
// Не компилировались в среде разработки агентов (реестр PlatformIO закрыт) — проверяются `pio run` у Андрея и в CI.
#pragma once

#include <Arduino.h>

#include <atomic>

#include "bl_machine.h"

namespace bl {

// Реле на линию лампы. begin() — первое, что делает прошивка: реле выключено до решения логики.
class RelayDriver {
 public:
  RelayDriver(int pin, bool activeHigh) : pin_(pin), activeHigh_(activeHigh) {}
  void begin();
  void set(bool on);
  bool on() const { return on_; }

 private:
  int pin_;
  bool activeHigh_;
  bool on_ = false;
};

// Индикатор WS2812 (один светодиод, RMT через neopixelWrite Arduino-ESP32). Узоры мигания — здесь.
class LedDriver {
 public:
  explicit LedDriver(int pin) : pin_(pin) {}
  void begin();
  void set(Led led, int brightness);
  void update(uint32_t nowMs);

 private:
  void write(uint8_t r, uint8_t g, uint8_t b);
  int pin_;
  Led led_ = Led::Off;
  int brightness_ = 128;
  uint32_t lastRgb_ = 0xFFFFFFFF;
};

// Пищалка (активная, на GPIO): beep(n) — n коротких сигналов по 150 мс через 150 мс, без блокировки.
class BuzzerDriver {
 public:
  explicit BuzzerDriver(int pin) : pin_(pin) {}
  void begin();
  void beep(int count, uint32_t nowMs);
  void update(uint32_t nowMs);

 private:
  int pin_;
  int left_ = 0;  // оставшиеся переключения (вкл/выкл)
  bool on_ = false;
  uint32_t nextAt_ = 0;
};

// Датчик тока: трансформатор тока на нагрузочном резисторе со смещением Vcc/2 на вход АЦП1.
// Отдельная задача снимает ~2000 выборок/с, окно 200 мс (10 периодов 50 Гц): среднее — смещение,
// среднеквадратичное отклонение — ток. Последнее значение читается без блокировки.
class CurrentDriver {
 public:
  CurrentDriver(int pin, int maPerMv) : pin_(pin), maPerMv_(maPerMv) {}
  void begin();
  int32_t currentMa() const { return ma_.load(); }

 private:
  static void task(void* self);
  void run();
  int pin_;
  int maPerMv_;
  std::atomic<int32_t> ma_{0};
};

// Диммер: ШИМ LEDC 1 кГц на модуль 0–10 В или ШИМ-диммер лампы.
class DimmerDriver {
 public:
  explicit DimmerDriver(int pin) : pin_(pin) {}
  void begin();
  void set(int pct);

 private:
  int pin_;
  int pct_ = -1;
};

// bl::Hal поверх драйверов платы.
class BoardHal : public Hal {
 public:
  BoardHal();
  void begin();
  void update(uint32_t nowMs);
  void setRelay(bool on) override;
  void setDim(int pct) override;
  void setLed(Led led, int brightness) override;
  void beep(int count) override;
  int32_t currentMa() override;
  int rssi() override;

 private:
  RelayDriver relay_;
  LedDriver led_;
  BuzzerDriver buzzer_;
  CurrentDriver current_;
  DimmerDriver dimmer_;
};

}  // namespace bl
