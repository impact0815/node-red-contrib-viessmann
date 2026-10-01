/**
 * Tests of the fully automatic login.
 *
 * Core is the order that was still wrong in the original flow: on the first
 * start there is no refresh token – the login must then happen directly with
 * username and password, not only after a failed renewal with an empty token.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ViessmannApi, generateCodeChallenge, isValidCodeChallenge } = require('../lib/api');
const mock = require('./mock-server');

function apiFor(srv, extra = {}) {
    return new ViessmannApi(Object.assign({
        clientId: mock.CLIENT, username: mock.USER, password: mock.PASS,
        redirectUri: mock.REDIRECT, iamHost: srv.url, apiHost: srv.url, timeout: 5000
    }, extra));
}

test('first start without refresh token: log in directly, no empty renewal attempt', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const tokens = [];
    const api = apiFor(srv, { onTokens: (x) => tokens.push(x.refreshToken) });
    assert.ok(await api.getAccessToken());
    assert.strictEqual(srv.state.refreshCalls, 0);
    assert.strictEqual(srv.state.authorizeCalls, 1);
    assert.strictEqual(srv.state.codeExchanges, 1);
    assert.deepStrictEqual(tokens, [api.refreshToken]);
});

test('redirect URI is sent unencoded (otherwise "Invalid redirection URI")', async (t) => {
    const srv = await mock.start({ strictRawRedirect: true });
    t.after(() => srv.stop());
    await apiFor(srv).login();
    assert.match(srv.state.lastAuthorize.raw, /redirect_uri=http:\/\/localhost:1880\/authcode&/);
    assert.match(srv.state.lastAuthorize.raw, /scope=IoT%20User%20offline_access/);
});

test('login sends Basic Auth and all required parameters', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    await apiFor(srv).login();
    const { query, authorization } = srv.state.lastAuthorize;
    assert.strictEqual(authorization, 'Basic ' + Buffer.from(`${mock.USER}:${mock.PASS}`).toString('base64'));
    assert.strictEqual(query.client_id, mock.CLIENT);
    assert.strictEqual(query.redirect_uri, mock.REDIRECT);
    assert.strictEqual(query.response_type, 'code');
    assert.strictEqual(query.scope, 'IoT User offline_access');
    assert.ok(isValidCodeChallenge(query.code_challenge));
});

test('whitespace around the redirect URI is removed', async (t) => {
    const srv = await mock.start({ strictRawRedirect: true });
    t.after(() => srv.stop());
    await apiFor(srv, { redirectUri: '  ' + mock.REDIRECT + ' ' }).login();
    assert.strictEqual(srv.state.codeExchanges, 1);
});

test('a given code challenge is used and redeemed as verifier', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const challenge = 'A'.repeat(20) + '-._~' + 'z9'.repeat(12);
    await apiFor(srv, { codeChallenge: challenge }).login();
    assert.strictEqual(srv.state.lastAuthorize.query.code_challenge, challenge);
    assert.strictEqual(srv.state.codeExchanges, 1);
});

test('an existing refresh token is preferred – no login needed', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    await apiFor(srv, { refreshToken: 'refresh-1' }).getAccessToken();
    assert.strictEqual(srv.state.refreshCalls, 1);
    assert.strictEqual(srv.state.authorizeCalls, 0);
});

test('a rejected refresh token leads to an automatic new login', async (t) => {
    const srv = await mock.start({ rejectRefresh: true });
    t.after(() => srv.stop());
    const api = apiFor(srv, { refreshToken: 'expired' });
    assert.ok(await api.getAccessToken());
    assert.strictEqual(srv.state.authorizeCalls, 1);
    assert.match(api.refreshToken, /^refresh-login-/);
});

test('without password a rejected token gives a clear error', async (t) => {
    const srv = await mock.start({ rejectRefresh: true });
    t.after(() => srv.stop());
    await assert.rejects(() => apiFor(srv, { refreshToken: 'x', password: '' }).getAccessToken(),
        (err) => err.code === 'TOKEN_REFRESH_FAILED' && err.params.status === 400);
});

test('wrong password is reported with key LOGIN_REJECTED / code LOGIN_FAILED', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    await assert.rejects(() => apiFor(srv, { password: 'wrong' }).getAccessToken(), (err) => {
        assert.strictEqual(err.code, 'LOGIN_FAILED');
        assert.strictEqual(err.key, 'LOGIN_REJECTED');
        assert.match(err.message, /username or password/);
        return true;
    });
});

test('active reCAPTCHA is detected and named', async (t) => {
    const srv = await mock.start({ captcha: true });
    t.after(() => srv.stop());
    await assert.rejects(() => apiFor(srv).getAccessToken(), (err) => {
        assert.strictEqual(err.code, 'INTERACTIVE_LOGIN_REQUIRED');
        assert.match(err.message, /reCAPTCHA/);
        return true;
    });
});

test('a different redirect URI names the address that was sent', async (t) => {
    const srv = await mock.start({ registeredRedirect: 'https://ccu.local:1880/authcode' });
    t.after(() => srv.stop());
    await assert.rejects(() => apiFor(srv).getAccessToken(), (err) => {
        assert.strictEqual(err.code, 'REDIRECT_URI_MISMATCH');
        assert.match(err.message, /Invalid redirection URI/);
        assert.strictEqual(err.params.redirectUri, mock.REDIRECT);
        return true;
    });
});

test('an invalid code challenge is rejected before sending', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    await assert.rejects(() => apiFor(srv, { codeChallenge: 'too short!' }).getAccessToken(),
        (err) => err.code === 'BAD_CODE_CHALLENGE');
    assert.strictEqual(srv.state.authorizeCalls, 0);
});

test('incomplete credentials are reported clearly', async () => {
    await assert.rejects(() => new ViessmannApi({ clientId: 'c' }).getAccessToken(),
        (err) => err.code === 'NO_CREDENTIALS');
});

test('parallel calls trigger only one login (single flight)', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const api = apiFor(srv);
    await Promise.all([api.getAccessToken(), api.getAccessToken(), api.getAccessToken()]);
    assert.strictEqual(srv.state.authorizeCalls, 1);
});

test('the access token is reused until shortly before expiry', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());
    const api = apiFor(srv);
    assert.strictEqual(await api.getAccessToken(), await api.getAccessToken());
    assert.strictEqual(srv.state.tokenCalls, 1);
});

test('a rotated refresh token is taken over', async (t) => {
    const srv = await mock.start({ rotateRefreshToken: true });
    t.after(() => srv.stop());
    let reported = null;
    const api = apiFor(srv, { refreshToken: 'refresh-1', onTokens: (x) => { reported = x.refreshToken; } });
    await api.getAccessToken();
    assert.match(reported, /^refresh-rot-/);
});

test('generated code challenges are valid and new every time', () => {
    const a = generateCodeChallenge();
    assert.ok(isValidCodeChallenge(a));
    assert.notStrictEqual(a, generateCodeChallenge());
    assert.strictEqual(isValidCodeChallenge('x'.repeat(42)), false);
    assert.strictEqual(isValidCodeChallenge('a'.repeat(43) + '!'), false);
});
