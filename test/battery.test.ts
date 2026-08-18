/**
 * Battery readers, tested as parsers against captured output. Same reason the
 * Windows watcher is tested as data: two of these three platforms are not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePmset, parseSysfs, parseWin32Battery } from '../src/battery.ts';

test('pmset on AC power, captured from a charged laptop', () => {
  const out =
    "Now drawing from 'AC Power'\n" +
    ' -InternalBattery-0 (id=23986275)\t100%; charged; 0:00 remaining present: true\n';
  assert.deepEqual(parsePmset(out), { percent: 100, discharging: false });
});

test('pmset on battery power', () => {
  const out =
    "Now drawing from 'Battery Power'\n" +
    ' -InternalBattery-0 (id=23986275)\t87%; discharging; 3:21 remaining present: true\n';
  assert.deepEqual(parsePmset(out), { percent: 87, discharging: true });
});

test('pmset while charging is not discharging even though it is not full', () => {
  const out =
    "Now drawing from 'AC Power'\n" +
    ' -InternalBattery-0 (id=23986275)\t42%; charging; 1:12 remaining present: true\n';
  assert.deepEqual(parsePmset(out), { percent: 42, discharging: false });
});

test('a machine with no battery reads as no battery, not as zero percent', () => {
  assert.equal(parsePmset("Now drawing from 'AC Power'\n"), null);
  assert.equal(parsePmset(''), null);
});

test('sysfs reports capacity and status in two files', () => {
  assert.deepEqual(parseSysfs('87\n', 'Discharging\n'), { percent: 87, discharging: true });
  assert.deepEqual(parseSysfs('87\n', 'Charging\n'), { percent: 87, discharging: false });
  assert.deepEqual(parseSysfs('100\n', 'Full\n'), { percent: 100, discharging: false });
  assert.deepEqual(parseSysfs('64\n', 'Not charging\n'), { percent: 64, discharging: false });
});

test('sysfs files that say nothing useful yield no reading', () => {
  assert.equal(parseSysfs('', 'Discharging'), null);
  assert.equal(parseSysfs('not a number', 'Discharging'), null);
});

test('Win32_Battery status 1 is a battery being drained', () => {
  const out = 'EstimatedChargeRemaining : 87\nBatteryStatus            : 1\n';
  assert.deepEqual(parseWin32Battery(out), { percent: 87, discharging: true });
});

test('Win32_Battery status 2 means the machine has AC', () => {
  const out = 'EstimatedChargeRemaining : 87\nBatteryStatus            : 2\n';
  assert.deepEqual(parseWin32Battery(out), { percent: 87, discharging: false });
});

test('Win32_Battery low and critical are discharging states too', () => {
  for (const status of [4, 5]) {
    const out = `EstimatedChargeRemaining : 8\nBatteryStatus            : ${status}\n`;
    assert.deepEqual(parseWin32Battery(out), { percent: 8, discharging: true }, `status ${status}`);
  }
});

test('Win32_Battery charging states are not discharging', () => {
  for (const status of [3, 6, 7, 8, 9, 11]) {
    const out = `EstimatedChargeRemaining : 50\nBatteryStatus            : ${status}\n`;
    assert.deepEqual(parseWin32Battery(out), { percent: 50, discharging: false }, `status ${status}`);
  }
});

test('an unrecognised Win32_Battery status is not treated as draining', () => {
  // Guessing "draining" here would end a run on a plugged-in machine. The guard
  // would rather do nothing than act on a status it does not understand.
  const out = 'EstimatedChargeRemaining : 9\nBatteryStatus            : 10\n';
  assert.deepEqual(parseWin32Battery(out), { percent: 9, discharging: false });
});

test('a desktop reports no Win32_Battery at all', () => {
  assert.equal(parseWin32Battery(''), null);
  assert.equal(parseWin32Battery('\n\n'), null);
});
