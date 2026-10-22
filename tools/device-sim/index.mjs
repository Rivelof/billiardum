#!/usr/bin/env node
// Симулятор контроллеров столов: по виртуальному столу на каждое устройство из SIM_DEVICES_FILE.
// Протокол: docs/protocol.md. Контракты: docs/contracts/m0.md §7, docs/contracts/m1.md §9.

import { ConfigError, USAGE, loadConfig } from './lib/config.mjs';
import { createLogger, redactUrl } from './lib/log.mjs';
import { SimDevice } from './lib/device.mjs';
import { startControl } from './lib/control.mjs';

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
    faults: cfg.faults.map((f) => `${f.name}${f.table ? `@${f.table}` : ''}${f.ms !== null ? `:${f.ms}` : ''}`),
    nvs: cfg.nvsDir ? 'file' : 'memory',
  });
  if (!cfg.tls) log.warn('sim_tls_disabled', { note: 'mqtt:// только для тестов; контроллер ходит по mqtts://' });

  const devices = cfg.devices.map((device) => new SimDevice({
    device, mqttUrl: cfg.mqttUrl, ca: cfg.ca, caps: cfg.caps, faults: cfg.faults, nvsDir: cfg.nvsDir, log,
  }));
  for (const d of devices) d.start();

  let control = null;
  if (cfg.controlPort !== null) {
    try {
      control = await startControl({ devices, port: cfg.controlPort, host: cfg.controlHost, log });
    } catch (err) {
      log.error('sim_control_failed', { port: cfg.controlPort, error: err.code ?? err.message });
      process.exitCode = 2;
      await Promise.allSettled(devices.map((d) => d.stop()));
      process.exit(2);
    }
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('sim_stop', { signal });
    const timer = setTimeout(() => process.exit(0), 5000);
    timer.unref();
    await control?.close();
    await Promise.allSettled(devices.map((d) => d.stop()));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

await main();
