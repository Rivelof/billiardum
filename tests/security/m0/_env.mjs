// Общий помощник PoC-тестов безопасности M0. Читает .env и devices.json репозитория.
// Секреты не печатаются — наружу отдаются только объекты для подключения.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let loaded = false;
export function loadEnv() {
  if (!loaded) {
    process.loadEnvFile(path.join(REPO_ROOT, '.env'));
    loaded = true;
  }
}

/** Адреса с хоста: внутри Compose db:5432/mosquitto:8883 → localhost. */
export function hostUrl(value) {
  return String(value || '').replace('@db:', '@localhost:').replace('db:5432', 'localhost:54322').replace('mosquitto:', 'localhost:');
}

export function mqttUrl() {
  loadEnv();
  return (process.env.MQTT_URL || 'mqtts://localhost:8883').replace('mosquitto', 'localhost');
}

export function caFile() {
  loadEnv();
  const p = process.env.MQTT_CA_FILE || 'deploy/dev/certs/ca.crt';
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

export function ca() {
  return readFileSync(caFile());
}

export function adminUrl() {
  loadEnv();
  // DATABASE_ADMIN_URL указывает на localhost:54322 с хоста.
  return process.env.DATABASE_ADMIN_URL;
}

export function appUrl() {
  loadEnv();
  return process.env.DATABASE_URL || null;
}

export function devices() {
  const file = process.env.SIM_DEVICES_FILE
    ? (path.isAbsolute(process.env.SIM_DEVICES_FILE) ? process.env.SIM_DEVICES_FILE : path.join(REPO_ROOT, process.env.SIM_DEVICES_FILE))
    : path.join(REPO_ROOT, 'deploy/dev/devices.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function mqttAdmin() {
  loadEnv();
  return { username: process.env.MQTT_ADMIN_USER, password: process.env.MQTT_ADMIN_PASSWORD };
}
