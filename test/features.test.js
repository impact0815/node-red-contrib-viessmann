'use strict';

const test = require('node:test');
const assert = require('node:assert');
const f = require('../lib/features');
const { sampleFeatures, SCHEDULE } = require('./mock-server');

const list = f.normalizeFeatures(sampleFeatures());
const map = f.toMap(list);

test('unsupported data points are detected as not available', () => {
    const solar = map['heating.solar.sensors.temperature.collector'];
    assert.strictEqual(solar.isEnabled, false);
    assert.strictEqual(solar.available, false);
    assert.strictEqual(solar.empty, true);
});

test('existing data points deliver values and units', () => {
    const o = map['heating.sensors.temperature.outside'];
    assert.strictEqual(o.values.value, 17.3);
    assert.strictEqual(o.units.value, 'celsius');
});

test('deprecated data points name their successor', () => {
    assert.strictEqual(map['heating.dhw.sensors.temperature.hotWaterStorage'].deprecated.replacedBy,
        'heating.dhw.sensors.temperature.dhwCylinder');
});

test('flatten creates simple key/value pairs', () => {
    const flat = f.flatten(list);
    assert.strictEqual(flat['heating.dhw.temperature.main'], 58);
    assert.strictEqual(flat['heating.circuits.0.heating.curve.slope'], 0.5);
    assert.ok(!('heating.solar.sensors.temperature.collector' in flat));
});

test('filter by pattern and exact name', () => {
    assert.strictEqual(f.filterFeatures(list, ['heating.dhw.*']).length, 4);
    assert.strictEqual(f.filterFeatures(list, ['heating.dhw.temperature.main']).length, 1);
    assert.strictEqual(f.filterFeatures(list, []).length, list.length);
});

test('validation: maximum, type conversion, step, enum, required, unknown', () => {
    const t = map['heating.dhw.temperature.main'].commands[0];
    const max = f.validateCommandParams(t, { temperature: 75 });
    assert.strictEqual(max.problems[0].key, 'ABOVE_MAX');
    assert.deepStrictEqual(max.problems[0].params, { name: 'temperature', value: 75, max: 60 });
    assert.match(max.errors[0], /maximum 60/);
    assert.strictEqual(f.validateCommandParams(t, { temperature: '55' }).params.temperature, 55);
    assert.strictEqual(f.validateCommandParams(t, {}).problems[0].key, 'REQUIRED');
    assert.strictEqual(f.validateCommandParams(t, { temperature: 50, foo: 1 }).problems[0].key, 'UNKNOWN_PARAM');
    const curve = map['heating.circuits.0.heating.curve'].commands[0];
    assert.strictEqual(f.validateCommandParams(curve, { slope: 0.65, shift: 2 }).problems[0].key, 'STEPPING');
    const mode = map['heating.circuits.0.operating.modes.active'].commands[0];
    assert.strictEqual(f.validateCommandParams(mode, { mode: 'party' }).problems[0].key, 'NOT_ALLOWED');
    assert.strictEqual(f.validateCommandParams(mode, { mode: 'dhwAndHeating' }).valid, true);
});

test('schedule parameters are passed through unchanged', () => {
    const cmd = map['heating.dhw.pumps.circulation.schedule'].commands[0];
    const r = f.validateCommandParams(cmd, { newSchedule: SCHEDULE });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.params.newSchedule, SCHEDULE);
});

test('comparison detects whether the target value is already set', () => {
    assert.strictEqual(f.currentValueForCommand(map['heating.dhw.temperature.main'], 'setTargetTemperature', { temperature: 58 }).equal, true);
    assert.strictEqual(f.currentValueForCommand(map['heating.circuits.0.operating.modes.active'], 'setMode', { mode: 'dhw' }).equal, true);
    assert.strictEqual(f.currentValueForCommand(map['heating.circuits.0.heating.curve'], 'setCurve', { slope: 0.5, shift: 3 }).equal, true);
    assert.strictEqual(f.currentValueForCommand(map['heating.dhw.oneTimeCharge'], 'activate', {}).equal, false);
});

test('schedules are compared independent of order', () => {
    const sched = map['heating.dhw.pumps.circulation.schedule'];
    const reordered = {};
    for (const d of ['sun', 'sat', 'fri', 'thu', 'wed', 'tue', 'mon']) reordered[d] = SCHEDULE[d];
    assert.strictEqual(f.currentValueForCommand(sched, 'setSchedule', { newSchedule: reordered }).equal, true);
    const off = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    assert.strictEqual(f.currentValueForCommand(sched, 'setSchedule', { newSchedule: off }).equal, false);
});

test('summary counts correctly', () => {
    assert.deepStrictEqual(f.summarize(list), { total: 8, available: 7, unavailable: 1, writable: 5, deprecated: 1 });
});
