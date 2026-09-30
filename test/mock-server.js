/**
 * Simulator der Viessmann-API für die Tests.
 *
 * Bildet neben der eigentlichen API auch den Identity Provider nach:
 *   GET  /idp/v3/authorize  – prüft Basic Auth und antwortet mit einer
 *                             302-Weiterleitung auf die Redirect-URI inkl. Code
 *   POST /idp/v3/token      – tauscht Code bzw. Refresh Token gegen Token
 *
 * Steuerbare Sonderfälle: falsches Passwort, aktives reCAPTCHA (Login-Seite
 * statt Weiterleitung), falsche Redirect-URI, abgelehntes Refresh Token,
 * rotierende Token, HTTP 401 bei der API, Rate Limit.
 */

'use strict';

const http = require('http');

const USER = 'max@example.com';
const PASS = 'geheim';
const CLIENT = 'client-1';
const REDIRECT = 'http://localhost:1880/authcode';

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => resolve(data));
    });
}

/** Feature-Liste, nachempfunden einer echten Vitodens-Antwort. */
function sampleFeatures() {
    return [
        {
            feature: 'heating.dhw.temperature.main',
            deviceId: '0', gatewayId: 'GW1', timestamp: '2026-09-29T03:30:47.336Z',
            isEnabled: true, isReady: true,
            properties: { value: { type: 'number', value: 58, unit: 'celsius' } },
            commands: {
                setTargetTemperature: {
                    name: 'setTargetTemperature', isExecutable: true,
                    params: { temperature: { type: 'number', required: true, constraints: { min: 10, max: 60, stepping: 1 } } }
                }
            }
        },
        {
            feature: 'heating.circuits.0.operating.modes.active',
            deviceId: '0', isEnabled: true, isReady: true,
            properties: { value: { type: 'string', value: 'dhw' } },
            commands: {
                setMode: {
                    name: 'setMode', isExecutable: true,
                    params: { mode: { type: 'string', required: true, constraints: { enum: ['dhw', 'dhwAndHeating', 'forcedNormal', 'forcedReduced', 'standby'] } } }
                }
            }
        },
        {
            feature: 'heating.circuits.0.heating.curve',
            deviceId: '0', isEnabled: true, isReady: true,
            properties: { shift: { type: 'number', value: 3, unit: '' }, slope: { type: 'number', value: 0.5, unit: '' } },
            commands: {
                setCurve: {
                    name: 'setCurve', isExecutable: true,
                    params: {
                        slope: { type: 'number', required: true, constraints: { min: 0.2, max: 3.5, stepping: 0.1 } },
                        shift: { type: 'number', required: true, constraints: { min: -13, max: 40, stepping: 1 } }
                    }
                }
            }
        },
        {
            feature: 'heating.sensors.temperature.outside',
            deviceId: '0', isEnabled: true, isReady: true,
            properties: {
                value: { type: 'number', value: 17.3, unit: 'celsius' },
                status: { type: 'string', value: 'connected' }
            },
            commands: {}
        },
        {
            feature: 'heating.solar.sensors.temperature.collector',
            deviceId: '0', isEnabled: false, isReady: true, properties: {}, commands: {}
        },
        {
            feature: 'heating.dhw.sensors.temperature.hotWaterStorage',
            deviceId: '0', isEnabled: true, isReady: true,
            properties: {
                value: { type: 'number', value: 54.8, unit: 'celsius' },
                status: { type: 'string', value: 'connected' }
            },
            commands: {},
            deprecated: { removalDate: '2024-09-15', info: 'replaced by heating.dhw.sensors.temperature.dhwCylinder' }
        },
        {
            feature: 'heating.dhw.oneTimeCharge',
            deviceId: '0', isEnabled: true, isReady: true,
            properties: { active: { type: 'boolean', value: false } },
            commands: {
                activate: { name: 'activate', isExecutable: true, params: {} },
                deactivate: { name: 'deactivate', isExecutable: true, params: {} }
            }
        }
    ];
}

async function start(behaviour = {}) {
    const state = Object.assign({
        validAccessToken: null,
        refreshToken: 'refresh-1',     // gilt als gültiges Refresh Token
        rotateRefreshToken: false,
        rejectRefresh: false,          // jedes Refresh Token ablehnen (abgelaufen)
        captcha: false,                // reCAPTCHA aktiv → Login-Seite statt Weiterleitung
        registeredRedirect: REDIRECT,
        expireFirstApiCall: false,
        rateLimit: false,
        authorizeCalls: 0,
        tokenCalls: 0,
        refreshCalls: 0,
        codeExchanges: 0,
        featureCalls: 0,
        lastAuthorize: null,
        issuedCodes: new Map(),        // code → code_challenge
        commands: []
    }, behaviour);

    let counter = 0;
    let firstApiCallDone = false;

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const json = (code, obj, headers = {}) => {
            res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers));
            res.end(obj === undefined ? '' : JSON.stringify(obj));
        };

        /* ---------------- Identity Provider: authorize ---------------- */
        if (url.pathname === '/idp/v3/authorize') {
            state.authorizeCalls++;
            const q = Object.fromEntries(url.searchParams.entries());
            state.lastAuthorize = { query: q, authorization: req.headers.authorization || null };

            if (state.captcha) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end('<html><body><form>Login + reCAPTCHA</form></body></html>');
            }

            const auth = req.headers.authorization || '';
            const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
            if (auth !== expected) {
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Viessmann"' });
                return res.end('Unauthorized');
            }

            if (q.client_id !== CLIENT) {
                return json(400, { error: 'invalid_client' });
            }

            if (q.redirect_uri !== state.registeredRedirect) {
                res.writeHead(302, {
                    Location: `${url.origin || 'http://localhost'}/error?error=invalid_request&error_description=redirect_uri+mismatch`
                });
                return res.end();
            }

            const code = 'code-' + (++counter);
            state.issuedCodes.set(code, q.code_challenge);
            res.writeHead(302, { Location: `${q.redirect_uri}?code=${code}` });
            return res.end();
        }

        /* ---------------- Identity Provider: token ---------------- */
        if (url.pathname === '/idp/v3/token') {
            state.tokenCalls++;
            const p = new URLSearchParams(await readBody(req));

            if (p.get('grant_type') === 'authorization_code') {
                state.codeExchanges++;
                const code = p.get('code');
                const challenge = state.issuedCodes.get(code);
                if (!challenge) return json(400, { error: 'invalid_grant', error_description: 'code not valid' });
                if (p.get('code_verifier') !== challenge) {
                    return json(400, { error: 'invalid_grant', error_description: 'code_verifier mismatch' });
                }
                if (p.get('redirect_uri') !== state.registeredRedirect) {
                    return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
                }
                state.issuedCodes.delete(code); // Codes sind einmalig
                state.refreshToken = 'refresh-login-' + (++counter);
                state.validAccessToken = 'access-' + (++counter);
                return json(200, {
                    access_token: state.validAccessToken,
                    refresh_token: state.refreshToken,
                    expires_in: 3600,
                    token_type: 'Bearer'
                });
            }

            if (p.get('grant_type') === 'refresh_token') {
                state.refreshCalls++;
                if (state.rejectRefresh || p.get('refresh_token') !== state.refreshToken) {
                    return json(400, { error: 'invalid_grant' });
                }
                state.validAccessToken = 'access-' + (++counter);
                const body = { access_token: state.validAccessToken, expires_in: 3600, token_type: 'Bearer' };
                if (state.rotateRefreshToken) {
                    state.refreshToken = 'refresh-rot-' + (++counter);
                    body.refresh_token = state.refreshToken;
                }
                return json(200, body);
            }

            return json(400, { error: 'unsupported_grant_type' });
        }

        /* ---------------- API ---------------- */
        if (state.expireFirstApiCall && !firstApiCallDone) {
            firstApiCallDone = true;
            return json(401, { message: 'token expired' });
        }
        if (!state.validAccessToken || req.headers.authorization !== `Bearer ${state.validAccessToken}`) {
            return json(401, { message: 'unauthorized' });
        }
        if (state.rateLimit) {
            return json(429, { message: 'rate limit exceeded' }, { 'Retry-After': '120' });
        }

        if (url.pathname === '/iot/v2/equipment/installations') {
            return json(200, { data: [{ id: 2331048, description: 'Zuhause' }] });
        }
        if (url.pathname === '/iot/v2/equipment/gateways') {
            return json(200, { data: [{ serial: '7637415032242231', installationId: 2331048 }] });
        }
        if (/\/devices$/.test(url.pathname)) {
            return json(200, { data: [{ id: '0', deviceType: 'heating' }] });
        }

        const cmd = url.pathname.match(/\/features\/([^/]+)\/commands\/([^/]+)$/);
        if (cmd && req.method === 'POST') {
            const raw = await readBody(req);
            state.commands.push({
                feature: decodeURIComponent(cmd[1]),
                command: decodeURIComponent(cmd[2]),
                params: raw ? JSON.parse(raw) : {}
            });
            return json(200, { data: { success: true } });
        }

        if (/\/features$/.test(url.pathname)) {
            state.featureCalls++;
            return json(200, { data: sampleFeatures() });
        }

        return json(404, { message: 'not found' });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    return {
        state,
        url: `http://127.0.0.1:${port}`,
        async stop() {
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

module.exports = { start, sampleFeatures, USER, PASS, CLIENT, REDIRECT };
