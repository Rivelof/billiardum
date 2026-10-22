#include "bl_drivers.h"

#include <WiFi.h>
#include <math.h>

#include "bl_board.h"

namespace bl {

// ——— Реле ———

void RelayDriver::begin() {
  // Сначала уровень «выключено», потом выход: без короткого включения лампы при старте.
  digitalWrite(pin_, activeHigh_ ? LOW : HIGH);
  pinMode(pin_, OUTPUT);
  set(false);
}

void RelayDriver::set(bool on) {
  on_ = on;
  digitalWrite(pin_, (on == activeHigh_) ? HIGH : LOW);
}

// ——— Индикатор ———

void LedDriver::begin() {
  if (pin_ < 0) return;
  write(0, 0, 0);
}

void LedDriver::set(Led led, int brightness) {
  led_ = led;
  brightness_ = brightness < 0 ? 0 : (brightness > 255 ? 255 : brightness);
}

void LedDriver::write(uint8_t r, uint8_t g, uint8_t b) {
  uint32_t rgb = ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
  if (rgb == lastRgb_) return;
  lastRgb_ = rgb;
  neopixelWrite((uint8_t)pin_, r, g, b);
}

void LedDriver::update(uint32_t nowMs) {
  if (pin_ < 0) return;
  uint8_t v = (uint8_t)brightness_;
  bool slow = (nowMs / 500) % 2 == 0;  // 1 Гц
  bool fast = (nowMs / 125) % 2 == 0;  // 4 Гц
  switch (led_) {
    case Led::Off: write(0, 0, 0); break;
    case Led::GreenDim: write(0, (uint8_t)(v / 4), 0); break;
    case Led::WhiteBlink: slow ? write(v, v, v) : write(0, 0, 0); break;
    case Led::Blue: write(0, 0, v); break;
    case Led::YellowBlink: slow ? write(v, (uint8_t)(v / 2), 0) : write(0, 0, 0); break;
    case Led::Red: write(v, 0, 0); break;
    case Led::RedFast: fast ? write(v, 0, 0) : write(0, 0, 0); break;
    case Led::Purple: write((uint8_t)(v / 2), 0, v); break;
    case Led::Identify: {
      // Поиск стола при монтаже: смена цвета 5 раз в секунду, всегда на полной яркости.
      switch ((nowMs / 200) % 4) {
        case 0: write(255, 0, 0); break;
        case 1: write(0, 255, 0); break;
        case 2: write(0, 0, 255); break;
        default: write(255, 255, 255); break;
      }
      break;
    }
  }
}

// ——— Пищалка ———

void BuzzerDriver::begin() {
  if (pin_ < 0) return;
  digitalWrite(pin_, LOW);
  pinMode(pin_, OUTPUT);
}

void BuzzerDriver::beep(int count, uint32_t nowMs) {
  if (pin_ < 0 || count <= 0) return;
  left_ = count * 2 - 1;
  on_ = true;
  digitalWrite(pin_, HIGH);
  nextAt_ = nowMs + 150;
}

void BuzzerDriver::update(uint32_t nowMs) {
  if (pin_ < 0 || left_ <= 0 || (int32_t)(nowMs - nextAt_) < 0) return;
  on_ = !on_;
  digitalWrite(pin_, on_ ? HIGH : LOW);
  left_ -= 1;
  nextAt_ = nowMs + 150;
}

// ——— Датчик тока ———

void CurrentDriver::begin() {
  if (pin_ < 0) return;
  analogSetPinAttenuation((uint8_t)pin_, ADC_11db);
  xTaskCreatePinnedToCore(&CurrentDriver::task, "bl_current", 3072, this, 1, nullptr, 0);
}

void CurrentDriver::task(void* self) { static_cast<CurrentDriver*>(self)->run(); }

void CurrentDriver::run() {
  const int kSamples = 200;  // 1 выборка в мс, окно 200 мс = 10 периодов 50 Гц
  TickType_t wake = xTaskGetTickCount();
  for (;;) {
    double sum = 0, sumSq = 0;
    for (int i = 0; i < kSamples; ++i) {
      double mv = (double)analogReadMilliVolts((uint8_t)pin_);
      sum += mv;
      sumSq += mv * mv;
      vTaskDelayUntil(&wake, pdMS_TO_TICKS(1) > 0 ? pdMS_TO_TICKS(1) : 1);
    }
    double mean = sum / kSamples;
    double var = sumSq / kSamples - mean * mean;
    double rmsMv = var > 0 ? sqrt(var) : 0;
    ma_.store((int32_t)lround(rmsMv * maPerMv_));
  }
}

// ——— Диммер ———

namespace {
constexpr int kDimChannel = 0;
constexpr int kDimFreq = 1000;
constexpr int kDimBits = 10;
}  // namespace

void DimmerDriver::begin() {
  if (pin_ < 0) return;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach((uint8_t)pin_, kDimFreq, kDimBits);
#else
  ledcSetup(kDimChannel, kDimFreq, kDimBits);
  ledcAttachPin((uint8_t)pin_, kDimChannel);
#endif
  set(0);
}

void DimmerDriver::set(int pct) {
  if (pin_ < 0 || pct == pct_) return;
  pct_ = pct;
  uint32_t duty = (uint32_t)((1u << kDimBits) - 1) * (uint32_t)(pct < 0 ? 0 : (pct > 100 ? 100 : pct)) / 100u;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite((uint8_t)pin_, duty);
#else
  ledcWrite(kDimChannel, duty);
#endif
}

// ——— Hal ———

BoardHal::BoardHal()
    : relay_(BL_PIN_RELAY, BL_RELAY_ACTIVE_HIGH != 0),
      led_(BL_PIN_LED),
      buzzer_(BL_PIN_BUZZER),
      current_(BL_PIN_CURRENT, BL_CT_MA_PER_MV),
      dimmer_(BL_PIN_DIMMER) {}

void BoardHal::begin() {
  relay_.begin();  // первым: свет выключен
  dimmer_.begin();
  led_.begin();
  buzzer_.begin();
  current_.begin();
}

void BoardHal::update(uint32_t nowMs) {
  led_.update(nowMs);
  buzzer_.update(nowMs);
}

void BoardHal::setRelay(bool on) { relay_.set(on); }
void BoardHal::setDim(int pct) { dimmer_.set(pct); }
void BoardHal::setLed(Led led, int brightness) { led_.set(led, brightness); }
void BoardHal::beep(int count) { buzzer_.beep(count, (uint32_t)millis()); }
int32_t BoardHal::currentMa() { return BL_PIN_CURRENT >= 0 ? current_.currentMa() : -1; }
int BoardHal::rssi() { return WiFi.status() == WL_CONNECTED ? (int)WiFi.RSSI() : 0; }

}  // namespace bl
