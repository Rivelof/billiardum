#!/usr/bin/env node
// Симулятор контроллеров столов: по виртуальному столу на каждое устройство из SIM_DEVICES_FILE.
// Протокол: docs/protocol.md. Контракт: docs/contracts/m0.md §7.

import { ConfigError, USAGE, loadConfig } from './lib/config.mjs';
import { createLogger, redactUrl } from './lib/log.mjs';
import { SimDevice } from './lib/device.mjs';

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    createLogger().error('sim_config_error', { error: err.message });
    process.exitCode = 2;
    return;
  }
  if (cfg.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const log = createLogger({ level: cfg.logLevel });
  if (cfg.logLevelInvalid) log.warn('sim_log_level_invalid', { using: cfg.logLevel });
  log.info('sim_start', {
    devices: cfg.devices.length,
    tables: cfg.devices.map((d) => d.table),
    mqtt_url: redactUrl(cfg.mqttUrl),
    tls: cfg.tls,
    caps: cfg.caps,
    faults: cfg.faults.map((f) => (f.table ? `${f.name}@${f.table}` : f.name)),
  });
  if (!cfg.tls) log.warn('sim_tls_disabled', { note: 'mqtt:// только для тестов; контроллер ходит по mqtts://' });

  const devices = cfg.devices.map((device) => new SimDevice({
    device, mqttUrl: cfg.mqttUrl, ca: cfg.ca, caps: cfg.caps, faults: cfg.faults, log,
  }));
  for (const d of devices) d.start();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('sim_stop', { signal });
    const timer = setTimeout(() => process.exit(0), 5000);
    timer.unref();
    await Promise.allSettled(devices.map((d) => d.stop()));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

await main();
