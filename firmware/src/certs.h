// Закреплённые сертификаты и ключ подписи образов (protocol.md §2, §8). Это открытые данные, не секреты.
// Настоящие значения — в src/certs.local.h (не в git): у прода и у стенда разработки свои CA.
//   kMqttCaPem    — CA брокера Mosquitto (сертификат брокера ECDSA P-256);
//   kApiCaPem     — CA HTTPS API (привязка /api/devices/claim) и сервера образов OTA;
//   kOtaPubKeyPem — открытый ключ ECDSA P-256, которым проверяется image_sig.
// Без certs.local.h прошивка собирается (для CI), но не подключится ни к одному брокеру и не примет
// ни одного обновления: TLS не установится, а свет без команд сервера не включится.
#pragma once

#if __has_include("certs.local.h")
#include "certs.local.h"
#else
#warning "src/certs.local.h нет: прошивка без закреплённых CA и ключа OTA (только проверка сборки)"
static const char kMqttCaPem[] = "";
static const char kApiCaPem[] = "";
static const char kOtaPubKeyPem[] = "";
#endif
