/**
 * Tests der vollautomatischen Anmeldung.
 *
 * Kern ist die Reihenfolge, die im ursprünglichen Flow noch falsch war:
 * Beim Erststart gibt es kein Refresh Token – die Anmeldung muss dann direkt
 * mit Benutzer und Passwort erfolgen, nicht erst nach einem gescheiterten
 * Erneuerungsversuch mit leerem Token.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ViessmannApi, generateCodeChallenge, isValidCodeChallenge } = require('../lib/api');
const mock = require('./mock-server');

function apiFor(srv, extra = {}) {
    return new ViessmannApi(Object.assign({
        clientId: mock.CLIENT,
        username: mock.USER,
        password: mock.PASS,
        redirectUri: mock.REDIRECT,
        iamHost: srv.url,
        apiHost: srv.url,
        timeout: 5000
    }, extra));
}

test('Erststart ohne Refresh Token: direkt anmelden, kein leerer Erneuerungsversuch', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const tokens = [];
    const api = apiFor(srv, { onTokens: (x) => tokens.push(x.refreshToken) });
    const access = await api.getAccessToken();

    assert.ok(access);
    assert.strictEqual(srv.state.refreshCalls, 0, 'kein Refresh-Versuch mit leerem Token');
    assert.strictEqual(srv.state.authorizeCalls, 1);
    assert.strictEqual(srv.state.codeExchanges, 1);
    assert.match(api.refreshToken, /^refresh-login-/);
    assert.deepStrictEqual(tokens, [api.refreshToken], 'neues Refresh Token wurde gemeldet');
});

test('Anmeldung schickt Basic Auth und alle Pflichtparameter', async (t) => {
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

test('vorgegebene Code Challenge wird verwendet und als Verifier eingelöst', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const challenge = 'A'.repeat(20) + '-._~' + 'z9'.repeat(12);
    await apiFor(srv, { codeChallenge: challenge }).login();

    assert.strictEqual(srv.state.lastAuthorize.query.code_challenge, challenge);
    assert.strictEqual(srv.state.codeExchanges, 1, 'Mock prüft code_verifier === code_challenge');
});

test('vorhandenes Refresh Token wird bevorzugt – keine Anmeldung nötig', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const api = apiFor(srv, { refreshToken: 'refresh-1' });
    await api.getAccessToken();

    assert.strictEqual(srv.state.refreshCalls, 1);
    assert.strictEqual(srv.state.authorizeCalls, 0);
});

test('abgelehntes Refresh Token führt automatisch zur Neuanmeldung', async (t) => {
    const srv = await mock.start({ rejectRefresh: true });
    t.after(() => srv.stop());

    const api = apiFor(srv, { refreshToken: 'abgelaufen' });
    const access = await api.getAccessToken();

    assert.ok(access);
    assert.strictEqual(srv.state.refreshCalls, 1);
    assert.strictEqual(srv.state.authorizeCalls, 1);
    assert.match(api.refreshToken, /^refresh-login-/);
});

test('ohne Passwort gibt es bei abgelehntem Token einen klaren Fehler', async (t) => {
    const srv = await mock.start({ rejectRefresh: true });
    t.after(() => srv.stop());

    const api = apiFor(srv, { refreshToken: 'abgelaufen', password: '' });
    await assert.rejects(() => api.getAccessToken(), (err) => err.code === 'TOKEN_REFRESH_FAILED');
});

test('falsches Passwort wird verständlich gemeldet', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    await assert.rejects(() => apiFor(srv, { password: 'falsch' }).getAccessToken(), (err) => {
        assert.strictEqual(err.code, 'LOGIN_FAILED');
        assert.match(err.message, /Benutzername oder Passwort/);
        return true;
    });
});

test('aktives reCAPTCHA wird erkannt und benannt', async (t) => {
    const srv = await mock.start({ captcha: true });
    t.after(() => srv.stop());

    await assert.rejects(() => apiFor(srv).getAccessToken(), (err) => {
        assert.strictEqual(err.code, 'INTERACTIVE_LOGIN_REQUIRED');
        assert.match(err.message, /reCAPTCHA/);
        return true;
    });
});

test('abweichende Redirect-URI wird erkannt und benannt', async (t) => {
    const srv = await mock.start({ registeredRedirect: 'https://ccu.local:1880/authcode' });
    t.after(() => srv.stop());

    await assert.rejects(() => apiFor(srv).getAccessToken(), (err) => {
        assert.strictEqual(err.code, 'LOGIN_FAILED');
        assert.match(err.message, /Redirect-URI/);
        return true;
    });
});

test('ungültige Code Challenge wird vor dem Senden abgewiesen', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    await assert.rejects(() => apiFor(srv, { codeChallenge: 'zu kurz!' }).getAccessToken(), (err) => {
        assert.strictEqual(err.code, 'BAD_CODE_CHALLENGE');
        return true;
    });
    assert.strictEqual(srv.state.authorizeCalls, 0);
});

test('unvollständige Zugangsdaten werden klar gemeldet', async () => {
    const api = new ViessmannApi({ clientId: 'c' });
    await assert.rejects(() => api.getAccessToken(), (err) => {
        assert.strictEqual(err.code, 'NO_CREDENTIALS');
        assert.match(err.message, /Benutzername und Passwort/);
        return true;
    });
});

test('parallele Aufrufe lösen nur eine Anmeldung aus (Single Flight)', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const api = apiFor(srv);
    await Promise.all([api.getAccessToken(), api.getAccessToken(), api.getAccessToken()]);
    assert.strictEqual(srv.state.authorizeCalls, 1);
});

test('Access Token wird bis kurz vor Ablauf wiederverwendet', async (t) => {
    const srv = await mock.start();
    t.after(() => srv.stop());

    const api = apiFor(srv);
    const a = await api.getAccessToken();
    const b = await api.getAccessToken();
    assert.strictEqual(a, b);
    assert.strictEqual(srv.state.tokenCalls, 1);
});

test('rotiertes Refresh Token wird übernommen', async (t) => {
    const srv = await mock.start({ rotateRefreshToken: true });
    t.after(() => srv.stop());

    let reported = null;
    const api = apiFor(srv, { refreshToken: 'refresh-1', onTokens: (x) => { reported = x.refreshToken; } });
    await api.getAccessToken();

    assert.match(reported, /^refresh-rot-/);
    assert.strictEqual(api.refreshToken, reported);
});

test('erzeugte Code Challenges sind gültig und jedes Mal neu', () => {
    const a = generateCodeChallenge();
    const b = generateCodeChallenge();
    assert.ok(isValidCodeChallenge(a));
    assert.notStrictEqual(a, b);
    assert.strictEqual(isValidCodeChallenge('x'.repeat(42)), false);
    assert.strictEqual(isValidCodeChallenge('x'.repeat(129)), false);
    assert.strictEqual(isValidCodeChallenge('a'.repeat(43) + '!'), false);
});
