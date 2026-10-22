// Общие сценарии tools/device-sim/scenarios/*.json — те же прогоняет прошивка
// (firmware/test/native). Расхождение прошивки и симулятора — дефект.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios, runScenario } from '../lib/scenario.mjs';

const scenarios = loadScenarios();

test('сценариев не меньше минимума контракта M1', () => {
  assert.ok(scenarios.length >= 18, `сценариев ${scenarios.length}`);
  for (const { file, scenario } of scenarios) {
    assert.match(file, /^\d{2}-[a-z0-9-]+\.json$/, file);
    assert.equal(typeof scenario.name, 'string', file);
    assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0, file);
  }
});

for (const { file, scenario } of scenarios) {
  test(`сценарий ${file}: ${scenario.name}`, () => {
    const { failures } = runScenario(scenario);
    assert.deepEqual(failures, []);
  });
}
