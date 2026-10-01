'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ViessmannApi } = require('../lib/api');
const mock = require('./mock-server');

function apiFor(srv, extra = {}) {
    return new ViessmannApi(Object.assign({
        clientId: mock.CLIENT, username: mock.USER, password: mock.PASS,
        redirectUri: mock.REDIRECT, iamHost: srv.url, apiHost: srv.url, timeout: 5000
    }, extra));
}

test('HTTP 401 of the API leads to exactly one token renewal and retry', async (t) => {
    const srv = await mock.start({ expireFirstApiCall: true });
    t.after(() => srv.stop());
    assert.strictEqual((await apiFor(srv).getInstallations()).length, 1);
    assert.strictEqual(srv.state.authorizeCalls, 1);
    assert.strictEqual(srv.state.refreshCalls, 1);
});

test('rate limit gives an understandable error including Retry-After', async (t) => {
    const srv = await mock.start({ rateLimit: true });
    t.after(() => srv.stop());
    await assert.rejects(() => apiFor(srv).getFeatures({ installationId: '1', gatewaySerial: '2', deviceId: '0' }),
        (err) => err.code === 'RATE_LIMIT' && err.statusCode === 429 && err.retryAfter === 120);
});

test('auto-discovery finds installation, gateway and device', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    assert.deepStrictEqual(await apiFor(srv).resolveTargets(),
        { installationId: '2331048', gatewaySerial: '7637415032242231', deviceId: '0' });
});

test('fixed values take precedence over auto-discovery', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    assert.deepStrictEqual(await apiFor(srv).resolveTargets({ installationId: '111', gatewaySerial: '222', deviceId: '1' }),
        { installationId: '111', gatewaySerial: '222', deviceId: '1' });
});

test('data points are loaded and commands executed', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const api = apiFor(srv);
    assert.ok((await api.getFeatures()).length > 5);
    await api.executeCommand('heating.dhw.temperature.main', 'setTargetTemperature', { temperature: 55 });
    assert.deepStrictEqual(srv.state.commands[0],
        { feature: 'heating.dhw.temperature.main', command: 'setTargetTemperature', params: { temperature: 55 } });
});

test('a network error is reported as such', async () => {
    const api = new ViessmannApi({ clientId: 'c', username: 'u', password: 'p',
        iamHost: 'http://127.0.0.1:9', apiHost: 'http://127.0.0.1:9', timeout: 150 });
    await assert.rejects(() => api.getAccessToken(), (err) => ['TIMEOUT', 'NETWORK'].includes(err.code));
});

test('a network error during renewal does not trigger an unnecessary login', async () => {
    let authorizeCalls = 0;
    const fetchImpl = async (url) => {
        if (url.includes('/authorize')) authorizeCalls++;
        throw new Error('ECONNRESET');
    };
    const api = new ViessmannApi({ clientId: 'c', username: 'u', password: 'p', refreshToken: 'r', fetchImpl });
    await assert.rejects(() => api.getAccessToken(), (err) => err.code === 'NETWORK');
    assert.strictEqual(authorizeCalls, 0);
});
