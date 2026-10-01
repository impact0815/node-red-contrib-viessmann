/**
 * Tests of the nodes against a minimal Node-RED stand-in.
 * Checks registration, automatic login on first read, reading, writing,
 * safety mechanisms, editor endpoints and translated messages.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mock = require('./mock-server');
const { makeRED } = require('./red-mock');

function makeRes() {
    const res = { statusCode: 200, body: null,
        status(c) { res.statusCode = c; return res; },
        json(o) { res.body = o; return res; } };
    return res;
}

function configNode(RED, srv, overrides = {}, creds = {}) {
    RED.types['viessmann-config'].call({}, Object.assign({
        id: 'cfg1', type: 'viessmann-config', iamHost: srv.url, apiHost: srv.url,
        redirectUri: mock.REDIRECT, cacheTtl: 30, timeout: 5000, allowWrite: false, minWriteInterval: 0,
        credentials: Object.assign({ clientId: mock.CLIENT, username: mock.USER, password: mock.PASS }, creds)
    }, overrides));
    return RED.nodes.getNode('cfg1');
}

function node(RED, type, config) {
    RED.types[type].call({}, Object.assign({ type }, config));
    return RED.nodes.getNode(config.id);
}

function invoke(n, msg) {
    return new Promise((resolve, reject) => {
        const out = [];
        const r = n._handlers.input(msg, (m) => out.push(m), (err) => (err ? reject(err) : resolve(out)));
        if (r && r.then) r.then(() => resolve(out), reject);
    });
}

test('all three node types and the editor endpoints register', () => {
    const RED = makeRED();
    assert.ok(RED.types['viessmann-config'] && RED.types['viessmann-read'] && RED.types['viessmann-write']);
    assert.ok(RED.routes.post['/viessmann/test']);
    assert.ok(RED.routes.get['/viessmann/:id/features']);
});

test('first read logs in automatically and stores the refresh token', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv);
    const read = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', outputFormat: 'flat', interval: 0 });

    const [[data, status]] = await invoke(read, {});
    assert.strictEqual(status, null);
    assert.strictEqual(data.payload['heating.dhw.temperature.main'], 58);
    assert.strictEqual(srv.state.authorizeCalls, 1);
    assert.match(read._status.text, /values \(7\/8 available\)/);

    const saved = RED.credentialsWritten.at(-1);
    assert.match(saved.creds.refreshToken, /^refresh-login-/);
    assert.strictEqual(saved.creds.password, mock.PASS, 'other credentials are kept');
});

test('a stored refresh token is used after a restart without new login', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv, {}, { refreshToken: 'refresh-1' });
    await invoke(node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', interval: 0 }), {});
    assert.strictEqual(srv.state.authorizeCalls, 0);
    assert.strictEqual(srv.state.refreshCalls, 1);
});

test('reading uses the shared cache and passes message properties through', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv);
    const a = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', interval: 0 });
    const b = node(RED, 'viessmann-read', { id: 'r2', server: 'cfg1', interval: 0 });
    await invoke(a, {});
    const [[data]] = await invoke(b, { action: 'on' });
    assert.strictEqual(srv.state.featureCalls, 1);
    assert.strictEqual(data.action, 'on');
    assert.strictEqual(data.payload['heating.dhw.pumps.circulation.schedule'].values.entries.mon[0].start, '04:00');
});

test('split mode creates MQTT-ready messages', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv);
    const read = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', selection: 'pattern',
        pattern: 'heating.dhw.*', outputFormat: 'split', topicPrefix: 'heating', interval: 0 });
    const out = await invoke(read, {});
    const m = out.map((p) => p[0]).find((x) => x.feature === 'heating.dhw.temperature.main');
    assert.strictEqual(m.topic, 'heating/heating.dhw.temperature.main');
    assert.strictEqual(m.payload, 58);
});

test('login error goes to output 2, translated, and is reported only once', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv, {}, { password: 'wrong' });
    const read = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', interval: 0 });
    const first = await invoke(read, {});
    const second = await invoke(read, {});
    assert.strictEqual(first[0][0], null);
    assert.strictEqual(first[0][1].payload.code, 'LOGIN_FAILED');
    assert.match(first[0][1].payload.error, /username or password is incorrect/);
    assert.strictEqual(second.length, 0);
});

test('messages appear in German when Node-RED runs in German', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED('de');
    configNode(RED, srv, {}, { password: 'falsch' });
    const read = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', interval: 0 });
    const [[, status]] = await invoke(read, {});
    assert.match(status.payload.error, /Benutzername oder Passwort falsch/);

    const w = node(RED, 'viessmann-write', { id: 'w1', server: 'cfg1',
        feature: 'heating.dhw.temperature.main', command: 'setTargetTemperature' });
    const [[, err]] = await invoke(w, { payload: { temperature: 55 } });
    assert.match(err.payload.error, /Schreibzugriff erlauben/);
});

test('writing is locked without permission', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv);
    const w = node(RED, 'viessmann-write', { id: 'w1', server: 'cfg1',
        feature: 'heating.dhw.temperature.main', command: 'setTargetTemperature' });
    assert.strictEqual(w._status.text, 'writing locked');
    const [[ok, err]] = await invoke(w, { payload: { temperature: 55 } });
    assert.strictEqual(ok, null);
    assert.strictEqual(err.payload.code, 'WRITE_DISABLED');
    assert.strictEqual(srv.state.commands.length, 0);
});

test('writing: skip unchanged, limits, dry run, execute, rate guard', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv, { allowWrite: true, minWriteInterval: 60 });
    const base = { server: 'cfg1', feature: 'heating.dhw.temperature.main', command: 'setTargetTemperature' };

    const same = await invoke(node(RED, 'viessmann-write', Object.assign({ id: 'w1' }, base)), { payload: { temperature: 58 } });
    assert.strictEqual(same[0][0].payload.skipped, true);
    assert.match(same[0][0].payload.reason, /already set/);

    const bad = await invoke(node(RED, 'viessmann-write', Object.assign({ id: 'w2' }, base)), { payload: { temperature: 90 } });
    assert.strictEqual(bad[0][1].payload.code, 'VALIDATION_FAILED');
    assert.match(bad[0][1].payload.error, /above the maximum 60/);

    assert.strictEqual((await invoke(node(RED, 'viessmann-write', Object.assign({ id: 'w3', dryRun: true }, base)), { payload: { temperature: 55 } }))[0][0].payload.dryRun, true);
    assert.strictEqual(srv.state.commands.length, 0);

    const w = node(RED, 'viessmann-write', Object.assign({ id: 'w4' }, base));
    assert.strictEqual((await invoke(w, { payload: { temperature: 55 } }))[0][0].payload.previous, 58);
    const guard = await invoke(w, { payload: { temperature: 52 } });
    assert.strictEqual(guard[0][1].payload.code, 'RATE_GUARD');
    assert.match(guard[0][1].payload.error, /s left/);
    assert.strictEqual(srv.state.commands.length, 1);
});

test('German validation messages', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED('de');
    configNode(RED, srv, { allowWrite: true });
    const w = node(RED, 'viessmann-write', { id: 'w1', server: 'cfg1',
        feature: 'heating.dhw.temperature.main', command: 'setTargetTemperature' });
    const out = await invoke(w, { payload: { temperature: 90 } });
    assert.match(out[0][1].payload.error, /liegt über dem Maximum 60/);
});

test('schedule is written, identical schedule skipped', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv, { allowWrite: true, minWriteInterval: 0 });
    const w = node(RED, 'viessmann-write', { id: 'w1', server: 'cfg1',
        feature: 'heating.dhw.pumps.circulation.schedule', command: 'setSchedule' });

    assert.strictEqual((await invoke(w, { payload: { newSchedule: mock.SCHEDULE } }))[0][0].payload.skipped, true);
    const off = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    const done = await invoke(w, { payload: { newSchedule: off } });
    assert.strictEqual(done[0][0].payload.skipped, false);
    assert.deepStrictEqual(srv.state.commands[0].params, { newSchedule: off });
});

test('unknown command lists the available alternatives', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv, { allowWrite: true });
    const out = await invoke(node(RED, 'viessmann-write', { id: 'w1', server: 'cfg1' }),
        { feature: 'heating.dhw.temperature.main', command: 'setFoo', payload: {} });
    assert.deepStrictEqual(out[0][1].payload.availableCommands, ['setTargetTemperature']);
    assert.match(out[0][1].payload.error, /Available: setTargetTemperature/);
});

test('connection test in the dialog works before the first deploy', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    const res = makeRes();
    await RED.routes.post['/viessmann/test']({ body: {
        clientId: mock.CLIENT, username: mock.USER, password: mock.PASS,
        redirectUri: mock.REDIRECT, iamHost: srv.url, apiHost: srv.url } }, res);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.steps, ['Login successful', 'System found', 'Data points read']);
    assert.strictEqual(res.body.summary.available, 7);
});

test('connection test replaces password placeholders with stored values', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv);
    const res = makeRes();
    await RED.routes.post['/viessmann/test']({ body: {
        id: 'cfg1', clientId: mock.CLIENT, username: mock.USER, password: '__PWRD__',
        redirectUri: mock.REDIRECT, iamHost: srv.url, apiHost: srv.url } }, res);
    assert.strictEqual(res.body.ok, true);
});

test('connection test reports errors translated', async (t) => {
    const srv = await mock.start({ captcha: true });
    t.after(() => srv.stop());
    const RED = makeRED('de');
    const res = makeRes();
    await RED.routes.post['/viessmann/test']({ body: {
        clientId: mock.CLIENT, username: mock.USER, password: mock.PASS,
        redirectUri: mock.REDIRECT, iamHost: srv.url, apiHost: srv.url } }, res);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.code, 'INTERACTIVE_LOGIN_REQUIRED');
    assert.match(res.body.error, /interaktive Anmeldung/);
});

test('data point list for the editor contains commands and limits', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const RED = makeRED();
    configNode(RED, srv);
    const res = makeRes();
    await RED.routes.get['/viessmann/:id/features']({ params: { id: 'cfg1' }, query: {} }, res);
    const dhw = res.body.features.find((x) => x.feature === 'heating.dhw.temperature.main');
    assert.strictEqual(dhw.commands[0].params.temperature.constraints.max, 60);
});
