/**
 * Simulator of the Viessmann API for the tests.
 *
 * Besides the API it also simulates the identity provider:
 *   GET  /idp/v3/authorize  – checks Basic Auth and answers with a 302
 *                             redirect to the redirect URI incl. code
 *   POST /idp/v3/token      – exchanges code or refresh token for tokens
 *
 * Controllable special cases: wrong password, active reCAPTCHA (login page
 * instead of redirect), wrong or encoded redirect URI, rejected refresh
 * token, rotating tokens, HTTP 401, rate limit.
 */

'use strict';

const http = require('http');

const USER = 'max@example.com';
const PASS = 'secret';
const CLIENT = 'client-1';
const REDIRECT = 'http://localhost:1880/authcode';

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => resolve(data));
    });
}

const DAY = [{ start: '04:00', end: '07:00', mode: 'on', position: 0 }];
const SCHEDULE = { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY, sun: DAY };

/** Feature list modelled on a real Vitodens response. */
function sampleFeatures() {
    return [
        {
            feature: 'heating.dhw.temperature.main', deviceId: '0', gatewayId: 'GW1',
            timestamp: '2026-09-29T03:30:47.336Z', isEnabled: true, isReady: true,
            properties: { value: { type: 'number', value: 58, unit: 'celsius' } },
            commands: { setTargetTemperature: { name: 'setTargetTemperature', isExecutable: true,
                params: { temperature: { type: 'number', required: true, constraints: { min: 10, max: 60, stepping: 1 } } } } }
        },
        {
            feature: 'heating.circuits.0.operating.modes.active', deviceId: '0', isEnabled: true, isReady: true,
            properties: { value: { type: 'string', value: 'dhw' } },
            commands: { setMode: { name: 'setMode', isExecutable: true,
                params: { mode: { type: 'string', required: true, constraints: { enum: ['dhw', 'dhwAndHeating', 'forcedNormal', 'forcedReduced', 'standby'] } } } } }
        },
        {
            feature: 'heating.circuits.0.heating.curve', deviceId: '0', isEnabled: true, isReady: true,
            properties: { shift: { type: 'number', value: 3, unit: '' }, slope: { type: 'number', value: 0.5, unit: '' } },
            commands: { setCurve: { name: 'setCurve', isExecutable: true, params: {
                slope: { type: 'number', required: true, constraints: { min: 0.2, max: 3.5, stepping: 0.1 } },
                shift: { type: 'number', required: true, constraints: { min: -13, max: 40, stepping: 1 } } } } }
        },
        {
            feature: 'heating.sensors.temperature.outside', deviceId: '0', isEnabled: true, isReady: true,
            properties: { value: { type: 'number', value: 17.3, unit: 'celsius' }, status: { type: 'string', value: 'connected' } },
            commands: {}
        },
        { feature: 'heating.solar.sensors.temperature.collector', deviceId: '0', isEnabled: false, isReady: true, properties: {}, commands: {} },
        {
            feature: 'heating.dhw.sensors.temperature.hotWaterStorage', deviceId: '0', isEnabled: true, isReady: true,
            properties: { value: { type: 'number', value: 54.8, unit: 'celsius' }, status: { type: 'string', value: 'connected' } },
            commands: {},
            deprecated: { removalDate: '2024-09-15', info: 'replaced by heating.dhw.sensors.temperature.dhwCylinder' }
        },
        {
            feature: 'heating.dhw.oneTimeCharge', deviceId: '0', isEnabled: true, isReady: true,
            properties: { active: { type: 'boolean', value: false } },
            commands: { activate: { name: 'activate', isExecutable: true, params: {} },
                deactivate: { name: 'deactivate', isExecutable: true, params: {} } }
        },
        {
            feature: 'heating.dhw.pumps.circulation.schedule', deviceId: '0', isEnabled: true, isReady: true,
            properties: { active: { type: 'boolean', value: true }, entries: { type: 'Schedule', value: SCHEDULE } },
            commands: { setSchedule: { name: 'setSchedule', isExecutable: true, params: { newSchedule: { type: 'Schedule', required: true,
                constraints: { modes: ['on'], maxEntries: 4, resolution: 10, defaultMode: 'off', overlapAllowed: true } } } } }
        }
    ];
}

async function start(behavior = {}) {
    const state = Object.assign({
        validAccessToken: null,
        refreshToken: 'refresh-1',
        rotateRefreshToken: false,
        rejectRefresh: false,
        captcha: false,
        strictRawRedirect: false,     // like Viessmann: encoded redirect_uri → "Invalid redirection URI"
        registeredRedirect: REDIRECT,
        expireFirstApiCall: false,
        rateLimit: false,
        authorizeCalls: 0, tokenCalls: 0, refreshCalls: 0, codeExchanges: 0, featureCalls: 0,
        lastAuthorize: null,
        issuedCodes: new Map(),
        commands: []
    }, behavior);

    let counter = 0;
    let firstApiCallDone = false;

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const json = (code, obj, headers = {}) => {
            res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers));
            res.end(obj === undefined ? '' : JSON.stringify(obj));
        };

        if (url.pathname === '/idp/v3/authorize') {
            state.authorizeCalls++;
            const q = Object.fromEntries(url.searchParams.entries());
            state.lastAuthorize = { query: q, raw: req.url, authorization: req.headers.authorization || null };

            if (state.captcha) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end('<html><body><form>Login + reCAPTCHA</form></body></html>');
            }
            const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
            if ((req.headers.authorization || '') !== expected) {
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Viessmann"' });
                return res.end('Unauthorized');
            }
            if (q.client_id !== CLIENT) return json(400, { error: 'invalid_client' });

            const rawEncoded = /redirect_uri=[^&]*%3A/i.test(req.url);
            if ((state.strictRawRedirect && rawEncoded) || q.redirect_uri !== state.registeredRedirect) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                return res.end('Invalid redirection URI');
            }

            const code = 'code-' + (++counter);
            state.issuedCodes.set(code, q.code_challenge);
            res.writeHead(302, { Location: `${q.redirect_uri}?code=${code}` });
            return res.end();
        }

        if (url.pathname === '/idp/v3/token') {
            state.tokenCalls++;
            const p = new URLSearchParams(await readBody(req));

            if (p.get('grant_type') === 'authorization_code') {
                state.codeExchanges++;
                const challenge = state.issuedCodes.get(p.get('code'));
                if (!challenge) return json(400, { error: 'invalid_grant', error_description: 'code not valid' });
                if (p.get('code_verifier') !== challenge) return json(400, { error: 'invalid_grant', error_description: 'code_verifier mismatch' });
                if (p.get('redirect_uri') !== state.registeredRedirect) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
                state.issuedCodes.delete(p.get('code'));
                state.refreshToken = 'refresh-login-' + (++counter);
                state.validAccessToken = 'access-' + (++counter);
                return json(200, { access_token: state.validAccessToken, refresh_token: state.refreshToken, expires_in: 3600, token_type: 'Bearer' });
            }

            if (p.get('grant_type') === 'refresh_token') {
                state.refreshCalls++;
                if (state.rejectRefresh || p.get('refresh_token') !== state.refreshToken) return json(400, { error: 'invalid_grant' });
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

        if (state.expireFirstApiCall && !firstApiCallDone) {
            firstApiCallDone = true;
            return json(401, { message: 'token expired' });
        }
        if (!state.validAccessToken || req.headers.authorization !== `Bearer ${state.validAccessToken}`) {
            return json(401, { message: 'unauthorized' });
        }
        if (state.rateLimit) return json(429, { message: 'rate limit exceeded' }, { 'Retry-After': '120' });

        if (url.pathname === '/iot/v2/equipment/installations') return json(200, { data: [{ id: 2331048 }] });
        if (url.pathname === '/iot/v2/equipment/gateways') return json(200, { data: [{ serial: '7637415032242231', installationId: 2331048 }] });
        if (/\/devices$/.test(url.pathname)) return json(200, { data: [{ id: '0', deviceType: 'heating' }] });

        const cmd = url.pathname.match(/\/features\/([^/]+)\/commands\/([^/]+)$/);
        if (cmd && req.method === 'POST') {
            const raw = await readBody(req);
            state.commands.push({ feature: decodeURIComponent(cmd[1]), command: decodeURIComponent(cmd[2]), params: raw ? JSON.parse(raw) : {} });
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
        async stop() { await new Promise((resolve) => server.close(resolve)); }
    };
}

module.exports = { start, sampleFeatures, SCHEDULE, USER, PASS, CLIENT, REDIRECT };
