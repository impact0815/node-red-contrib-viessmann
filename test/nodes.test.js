/**
 * Tests der Nodes gegen eine minimale Node-RED-Attrappe.
 * Prüft Registrierung, automatische Anmeldung beim ersten Lesen, Lesen,
 * Schreiben, Schutzmechanismen und die Editor-Endpunkte.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mock = require('./mock-server');

function makeRED() {
    const types = {};
    const instances = {};
    const routes = { get: {}, post: {} };
    const RED = {
        types,
        routes,
        credentialsWritten: [],
        nodes: {
            createNode(node, config) {
                node.id = config.id;
                node.type = config.type;
                node.credentials = config.credentials || {};
                node._handlers = {};
                node.on = (ev, fn) => { node._handlers[ev] = fn; };
                node.status = (s) => { node._status = s; };
                node.send = () => {};
                node.error = () => {};
                node.warn = () => {};
                node.log = () => {};
                node.debug = () => {};
                instances[node.id] = node;
            },
            registerType(name, ctor) { types[name] = ctor; },
            getNode(id) { return instances[id] || null; },
            addCredentials(id, creds) { RED.credentialsWritten.push({ id, creds }); }
        },
        util: { cloneMessage: (m) => JSON.parse(JSON.stringify(m || {})) },
        httpAdmin: {
            get(p, ...h) { routes.get[p] = h[h.length - 1]; },
            post(p, ...h) { routes.post[p] = h[h.length - 1]; }
        },
        auth: { needsPermission: () => (req, res, next) => next && next() }
    };
    for (const m of ['../nodes/viessmann-config', '../nodes/viessmann-read', '../nodes/viessmann-write']) {
        delete require.cache[require.resolve(m)];
        require(m)(RED);
    }
    return RED;
}

function makeRes() {
    const res = {
        statusCode: 200, body: null,
        status(c) { res.statusCode = c; return res; },
        json(o) { res.body = o; return res; }
    };
    return res;
}

function configNode(RED, srv, overrides = {}, creds = {}) {
    const cfg = Object.assign({
        id: 'cfg1', type: 'viessmann-config', iamHost: srv.url, apiHost: srv.url,
        redirectUri: mock.REDIRECT, cacheTtl: 30, timeout: 5000, allowWrite: false, minWriteInterval: 0,
        credentials: Object.assign({ clientId: mock.CLIENT, username: mock.USER, password: mock.PASS }, creds)
    }, overrides);
    RED.types['viessmann-config'].call({}, cfg);
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

test('alle drei Node-Typen und die Editor-Endpunkte registrieren sich', () => {
    const RED = makeRED();
    assert.ok(RED.types['viessmann-config'] && RED.types['viessmann-read'] && RED.types['viessmann-write']);
    assert.ok(RED.routes.post['/viessmann/test']);
    assert.ok(RED.routes.get['/viessmann/:id/features']);
});

test('erstes Lesen meldet sich automatisch an und speichert das Refresh Token', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv);
    const read = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', outputFormat: 'flat', interval: 0 });

    const [[data, status]] = await invoke(read, {});
    assert.strictEqual(status, null);
    assert.strictEqual(data.payload['heating.dhw.temperature.main'], 58);
    assert.strictEqual(srv.state.authorizeCalls, 1);
    assert.strictEqual(srv.state.refreshCalls, 0);

    const saved = RED.credentialsWritten.at(-1);
    assert.strictEqual(saved.id, 'cfg1');
    assert.match(saved.creds.refreshToken, /^refresh-login-/);
    assert.strictEqual(saved.creds.username, mock.USER, 'übrige Credentials bleiben erhalten');
    assert.strictEqual(saved.creds.password, mock.PASS);
});

test('gespeichertes Refresh Token wird nach Neustart ohne Neuanmeldung genutzt', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv, {}, { refreshToken: 'refresh-1' });
    const read = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', interval: 0 });

    await invoke(read, {});
    assert.strictEqual(srv.state.authorizeCalls, 0);
    assert.strictEqual(srv.state.refreshCalls, 1);
});

test('Lesen nutzt den gemeinsamen Cache', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv);
    const a = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', interval: 0 });
    const b = node(RED, 'viessmann-read', { id: 'r2', server: 'cfg1', interval: 0 });
    await invoke(a, {});
    await invoke(b, {});
    assert.strictEqual(srv.state.featureCalls, 1);
});

test('Einzelmodus erzeugt MQTT-taugliche Nachrichten', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv);
    const read = node(RED, 'viessmann-read', {
        id: 'r1', server: 'cfg1', selection: 'pattern', pattern: 'heating.dhw.*',
        outputFormat: 'split', topicPrefix: 'heizung', interval: 0
    });
    const out = await invoke(read, {});
    const m = out.map((p) => p[0]).find((x) => x.feature === 'heating.dhw.temperature.main');
    assert.strictEqual(m.topic, 'heizung/heating.dhw.temperature.main');
    assert.strictEqual(m.payload, 58);
});

test('Anmeldefehler landet auf Ausgang 2 und wird nur einmal gemeldet', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv, {}, { password: 'falsch' });
    const read = node(RED, 'viessmann-read', { id: 'r1', server: 'cfg1', interval: 0 });

    const first = await invoke(read, {});
    const second = await invoke(read, {});
    assert.strictEqual(first[0][0], null);
    assert.strictEqual(first[0][1].payload.code, 'LOGIN_FAILED');
    assert.strictEqual(second.length, 0);
});

test('Schreiben ist ohne Freigabe gesperrt', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv);
    const w = node(RED, 'viessmann-write', {
        id: 'w1', server: 'cfg1', feature: 'heating.dhw.temperature.main', command: 'setTargetTemperature'
    });
    const [[ok, err]] = await invoke(w, { payload: { temperature: 55 } });
    assert.strictEqual(ok, null);
    assert.strictEqual(err.payload.code, 'WRITE_DISABLED');
    assert.strictEqual(srv.state.commands.length, 0);
});

test('Schreiben: ausführen, unverändert überspringen, Grenzen prüfen, Testlauf, Sperre', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv, { allowWrite: true, minWriteInterval: 60 });
    const base = { server: 'cfg1', feature: 'heating.dhw.temperature.main', command: 'setTargetTemperature' };

    const same = await invoke(node(RED, 'viessmann-write', Object.assign({ id: 'w1' }, base)), { payload: { temperature: 58 } });
    assert.strictEqual(same[0][0].payload.skipped, true);

    const bad = await invoke(node(RED, 'viessmann-write', Object.assign({ id: 'w2' }, base)), { payload: { temperature: 90 } });
    assert.strictEqual(bad[0][1].payload.code, 'VALIDATION_FAILED');

    const dry = await invoke(node(RED, 'viessmann-write', Object.assign({ id: 'w3', dryRun: true }, base)), { payload: { temperature: 55 } });
    assert.strictEqual(dry[0][0].payload.dryRun, true);
    assert.strictEqual(srv.state.commands.length, 0);

    const w = node(RED, 'viessmann-write', Object.assign({ id: 'w4' }, base));
    const done = await invoke(w, { payload: { temperature: 55 } });
    assert.strictEqual(done[0][0].payload.previous, 58);
    assert.strictEqual(srv.state.commands.length, 1);

    const blocked = await invoke(w, { payload: { temperature: 52 } });
    assert.strictEqual(blocked[0][1].payload.code, 'RATE_GUARD');
    assert.strictEqual(srv.state.commands.length, 1);
});

test('unbekannter Befehl nennt die verfügbaren Alternativen', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv, { allowWrite: true });
    const w = node(RED, 'viessmann-write', { id: 'w1', server: 'cfg1' });
    const out = await invoke(w, { feature: 'heating.dhw.temperature.main', command: 'setZielwert', payload: {} });
    assert.deepStrictEqual(out[0][1].payload.availableCommands, ['setTargetTemperature']);
});

test('Verbindungstest im Dialog funktioniert schon vor dem ersten Deploy', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    const res = makeRes();
    await RED.routes.post['/viessmann/test']({ body: {
        clientId: mock.CLIENT, username: mock.USER, password: mock.PASS,
        redirectUri: mock.REDIRECT, iamHost: srv.url, apiHost: srv.url
    } }, res);

    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.targets.installationId, '2331048');
    assert.strictEqual(res.body.summary.available, 6);
});

test('Verbindungstest ersetzt Passwort-Platzhalter durch gespeicherte Werte', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv);
    const res = makeRes();
    await RED.routes.post['/viessmann/test']({ body: {
        id: 'cfg1', clientId: mock.CLIENT, username: mock.USER, password: '__PWRD__',
        redirectUri: mock.REDIRECT, iamHost: srv.url, apiHost: srv.url
    } }, res);
    assert.strictEqual(res.body.ok, true);
});

test('Verbindungstest nennt den Schritt, an dem es scheitert', async (t) => {
    const srv = await mock.start({ captcha: true });
    t.after(() => srv.stop());

    const RED = makeRED();
    const res = makeRes();
    await RED.routes.post['/viessmann/test']({ body: {
        clientId: mock.CLIENT, username: mock.USER, password: mock.PASS,
        redirectUri: mock.REDIRECT, iamHost: srv.url, apiHost: srv.url
    } }, res);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.code, 'INTERACTIVE_LOGIN_REQUIRED');
    assert.deepStrictEqual(res.body.steps, []);
});

test('Datenpunktliste für den Editor enthält Befehle und Grenzen', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const RED = makeRED();
    configNode(RED, srv);
    const res = makeRes();
    await RED.routes.get['/viessmann/:id/features']({ params: { id: 'cfg1' }, query: {} }, res);
    const dhw = res.body.features.find((f) => f.feature === 'heating.dhw.temperature.main');
    assert.strictEqual(dhw.commands[0].params.temperature.constraints.max, 60);
});
