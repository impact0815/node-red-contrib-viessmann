'use strict';

const test = require('node:test');
const assert = require('node:assert');
const f = require('../lib/features');
const { sampleFeatures } = require('./mock-server');

const list = f.normalizeFeatures(sampleFeatures());
const map = f.toMap(list);

test('nicht unterstützte Datenpunkte werden als nicht verfügbar erkannt', () => {
    const solar = map['heating.solar.sensors.temperature.collector'];
    assert.strictEqual(solar.isEnabled, false);
    assert.strictEqual(solar.available, false);
    assert.strictEqual(solar.empty, true);
});

test('vorhandene Datenpunkte liefern Werte und Einheiten', () => {
    const outside = map['heating.sensors.temperature.outside'];
    assert.strictEqual(outside.available, true);
    assert.strictEqual(outside.values.value, 17.3);
    assert.strictEqual(outside.units.value, 'celsius');
});

test('veraltete Datenpunkte nennen ihren Nachfolger', () => {
    assert.strictEqual(map['heating.dhw.sensors.temperature.hotWaterStorage'].deprecated.replacedBy,
        'heating.dhw.sensors.temperature.dhwCylinder');
});

test('beschreibbare Datenpunkte werden markiert', () => {
    assert.strictEqual(map['heating.dhw.temperature.main'].writable, true);
    assert.strictEqual(map['heating.sensors.temperature.outside'].writable, false);
});

test('flatten erzeugt einfache Schlüssel/Wert-Paare', () => {
    const flat = f.flatten(list);
    assert.strictEqual(flat['heating.dhw.temperature.main'], 58);
    assert.strictEqual(flat['heating.circuits.0.heating.curve.slope'], 0.5);
    assert.ok(!('heating.solar.sensors.temperature.collector' in flat));
});

test('Filter nach Muster und exaktem Namen', () => {
    assert.strictEqual(f.filterFeatures(list, ['heating.dhw.*']).length, 3);
    assert.strictEqual(f.filterFeatures(list, ['heating.dhw.temperature.main']).length, 1);
    assert.strictEqual(f.filterFeatures(list, []).length, list.length);
});

test('Validierung: Maximum, Typumwandlung, Schrittweite, Enum, Pflicht, Unbekannt', () => {
    const t = map['heating.dhw.temperature.main'].commands[0];
    assert.match(f.validateCommandParams(t, { temperature: 75 }).errors[0], /Maximum 60/);
    assert.strictEqual(f.validateCommandParams(t, { temperature: '55' }).params.temperature, 55);
    assert.match(f.validateCommandParams(t, {}).errors[0], /Pflichtparameter/);
    assert.match(f.validateCommandParams(t, { temperature: 50, foo: 1 }).errors[0], /Unbekannter Parameter/);

    const curve = map['heating.circuits.0.heating.curve'].commands[0];
    assert.match(f.validateCommandParams(curve, { slope: 0.65, shift: 2 }).errors.join(' '), /Schrittweite/);

    const mode = map['heating.circuits.0.operating.modes.active'].commands[0];
    assert.strictEqual(f.validateCommandParams(mode, { mode: 'party' }).valid, false);
    assert.strictEqual(f.validateCommandParams(mode, { mode: 'dhwAndHeating' }).valid, true);
});

test('Vergleich erkennt, ob der Zielwert bereits anliegt', () => {
    assert.strictEqual(f.currentValueForCommand(map['heating.dhw.temperature.main'], 'setTargetTemperature', { temperature: 58 }).equal, true);
    assert.strictEqual(f.currentValueForCommand(map['heating.circuits.0.operating.modes.active'], 'setMode', { mode: 'dhw' }).equal, true);
    assert.strictEqual(f.currentValueForCommand(map['heating.circuits.0.heating.curve'], 'setCurve', { slope: 0.5, shift: 3 }).equal, true);
    assert.strictEqual(f.currentValueForCommand(map['heating.dhw.oneTimeCharge'], 'activate', {}).equal, false);
});

test('Zusammenfassung zählt korrekt', () => {
    assert.deepStrictEqual(f.summarize(list), { total: 7, available: 6, unavailable: 1, writable: 4, deprecated: 1 });
});
