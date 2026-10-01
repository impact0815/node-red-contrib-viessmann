/**
 * Minimal, dependency-free client for the Viessmann IoT API.
 *
 * The access flow (client ID, code challenge, authorization code, refresh
 * token, installation/gateway/device, features) is based on the excellent
 * guide by Rustimation.eu:
 *   https://www.rustimation.eu/index.php/1_zugang_api/
 * This Node-RED package would not exist without that work. Thank you!
 *
 * Official docs: https://api.viessmann-climatesolutions.com/documentation
 *
 * No external HTTP library on purpose: Node-RED runs on Node 18+ with a
 * built-in fetch(). Fewer dependencies = smaller attack surface.
 *
 * ---------------------------------------------------------------------------
 * Login flow – fully automatic, no browser
 * ---------------------------------------------------------------------------
 *   1. If a refresh token exists, it is used to get an access token.
 *   2. If there is none (first start) or it is rejected, the client logs in
 *      by itself: GET /idp/v3/authorize with HTTP Basic Auth (ViCare username
 *      and password). Viessmann answers with a redirect to the redirect URI
 *      that contains the authorization code.
 *   3. The redirect is deliberately NOT followed. The code is read directly
 *      from the Location header, so nothing has to listen at the redirect URI.
 *   4. The code is exchanged for access and refresh token.
 *
 * Important: the authorize URL is built exactly like in the proven
 * Rustimation flow – redirect_uri unencoded, scope with %20. Standard
 * encoding via URLSearchParams is rejected by Viessmann with
 * "Invalid redirection URI".
 */

'use strict';

const crypto = require('crypto');
const { ViessmannError } = require('./errors');

const DEFAULT_IAM_HOST = 'https://iam.viessmann-climatesolutions.com';
const DEFAULT_API_HOST = 'https://api.viessmann-climatesolutions.com';
const DEFAULT_REDIRECT_URI = 'http://localhost:1880/authcode';

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Creates a valid code challenge (PKCE "plain", 43–128 characters). */
function generateCodeChallenge() {
    return base64url(crypto.randomBytes(48)); // 64 characters
}

/** Checks a user-supplied code challenge. */
function isValidCodeChallenge(value) {
    return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

function nowMs() {
    return Date.now();
}

function parseJson(text) {
    try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
}

class ViessmannApi {
    /**
     * @param {object} opts
     * @param {string} opts.clientId        client ID from the Viessmann Developer Portal
     * @param {string} [opts.username]      ViCare username (e-mail)
     * @param {string} [opts.password]      ViCare password
     * @param {string} [opts.codeChallenge] PKCE code challenge (empty = automatic)
     * @param {string} [opts.redirectUri]   must exactly match the one stored in the portal
     * @param {string} [opts.refreshToken]  existing refresh token (optional)
     * @param {string} [opts.iamHost]       base URL of the identity provider
     * @param {string} [opts.apiHost]       base URL of the IoT API
     * @param {number} [opts.timeout]       timeout per request in ms (default 20000)
     * @param {function} [opts.log]         log(level, message) for diagnostics
     * @param {function} [opts.onTokens]    callback when a new refresh token arrives
     * @param {function} [opts.fetchImpl]   injectable fetch (for tests)
     */
    constructor(opts = {}) {
        this.clientId = opts.clientId;
        this.username = opts.username || '';
        this.password = opts.password || '';
        this.codeChallenge = opts.codeChallenge || '';
        this.redirectUri = (opts.redirectUri || DEFAULT_REDIRECT_URI).trim();
        this.refreshToken = opts.refreshToken || '';
        this.iamHost = (opts.iamHost || DEFAULT_IAM_HOST).replace(/\/+$/, '');
        this.apiHost = (opts.apiHost || DEFAULT_API_HOST).replace(/\/+$/, '');
        this.timeout = opts.timeout || 20000;
        this.log = opts.log || function () {};
        this.onTokens = opts.onTokens || function () {};
        this.fetchImpl = opts.fetchImpl || globalThis.fetch;

        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        this.lastLoginAt = 0;
        this._tokenPromise = null; // single flight: never two parallel token requests
        this._targets = null;      // cached installation/gateway/device
    }

    get canLogin() {
        return Boolean(this.clientId && this.username && this.password);
    }

    /* ------------------------------------------------------------------ *
     * Tokens
     * ------------------------------------------------------------------ */

    /**
     * Returns a valid access token. Renews automatically 60 s before expiry.
     * @param {boolean} [force] force renewal (e.g. after HTTP 401)
     */
    async getAccessToken(force = false) {
        if (!force && this.accessToken && nowMs() < this.accessTokenExpiresAt - 60000) {
            return this.accessToken;
        }
        if (this._tokenPromise) return this._tokenPromise;

        this._tokenPromise = this._obtainAccessToken()
            .finally(() => { this._tokenPromise = null; });
        return this._tokenPromise;
    }

    /**
     * The central order:
     *   refresh token present → renew.
     *   no refresh token or renewal rejected → log in automatically.
     *   network error → do NOT log in again (would not help).
     */
    async _obtainAccessToken() {
        if (!this.clientId) throw new ViessmannError('NO_CLIENT_ID');

        if (this.refreshToken) {
            try {
                return await this._refreshAccessToken();
            } catch (err) {
                const rejected = err.code === 'TOKEN_REFRESH_FAILED' &&
                    [400, 401, 403].includes(err.statusCode);
                if (!rejected || !this.canLogin) throw err;
                this.log('warn', 'Refresh token rejected – logging in again automatically.');
                this.refreshToken = '';
            }
        }

        if (!this.canLogin) throw new ViessmannError('NO_CREDENTIALS');
        await this.login();
        return this.accessToken;
    }

    async _refreshAccessToken() {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.clientId,
            refresh_token: this.refreshToken
        }).toString();

        const res = await this._fetch(`${this.iamHost}/idp/v3/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const text = await res.text();
        const json = parseJson(text);

        if (!res.ok || !json || !json.access_token) {
            throw new ViessmannError('TOKEN_REFRESH_FAILED', { status: res.status },
                { statusCode: res.status, body: json || text });
        }

        this._applyTokens(json);
        this.log('debug', `Access token renewed, valid for ${Number(json.expires_in) || 3600}s`);
        return this.accessToken;
    }

    _applyTokens(json) {
        this.accessToken = json.access_token || null;
        this.accessTokenExpiresAt = nowMs() + (Number(json.expires_in) || 3600) * 1000;

        // Viessmann does not necessarily rotate the refresh token – if it does,
        // the new value is taken over and reported.
        if (json.refresh_token && json.refresh_token !== this.refreshToken) {
            this.refreshToken = json.refresh_token;
            try { this.onTokens({ refreshToken: json.refresh_token }); } catch (_) { /* ignore */ }
        }
    }

    /**
     * Builds the authorize URL – exactly like the proven Rustimation flow:
     * redirect_uri unencoded, scope with %20.
     */
    buildAuthorizeUrl({ redirectUri, codeChallenge } = {}) {
        const redirect = (redirectUri || this.redirectUri).trim();
        const challenge = codeChallenge || this.codeChallenge;
        return `${this.iamHost}/idp/v3/authorize` +
            `?client_id=${encodeURIComponent(this.clientId)}` +
            `&redirect_uri=${redirect}` +
            '&response_type=code' +
            `&code_challenge=${challenge}` +
            '&scope=IoT%20User%20offline_access';
    }

    /**
     * Login step 1: get the authorization code with username and password.
     * Equivalent to the "Init Auth" node of the original flow.
     * @returns {Promise<{code: string, codeChallenge: string}>}
     */
    async requestAuthorizationCode() {
        let challenge = this.codeChallenge;
        if (!challenge) {
            challenge = generateCodeChallenge();
        } else if (!isValidCodeChallenge(challenge)) {
            throw new ViessmannError('BAD_CODE_CHALLENGE');
        }

        const url = this.buildAuthorizeUrl({ codeChallenge: challenge });
        const basic = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');

        const res = await this._fetch(url, {
            method: 'GET',
            headers: { Authorization: `Basic ${basic}` },
            redirect: 'manual'
        });

        if (res.status === 401) {
            throw new ViessmannError('LOGIN_REJECTED', {}, { code: 'LOGIN_FAILED', statusCode: 401 });
        }

        const location = res.headers && res.headers.get ? res.headers.get('location') : null;
        const redirectUri = this.redirectUri;

        if (res.status >= 300 && res.status < 400 && location) {
            let target;
            try {
                target = new URL(location, this.iamHost);
            } catch (_) {
                throw new ViessmannError('UNEXPECTED_REDIRECT', { location });
            }

            const code = target.searchParams.get('code');
            if (code) return { code, codeChallenge: challenge };

            const error = target.searchParams.get('error');
            if (error) {
                const detail = target.searchParams.get('error_description') || error;
                if (/redirect/i.test(detail)) {
                    throw new ViessmannError('REDIRECT_URI_MISMATCH', { detail, redirectUri }, { statusCode: res.status });
                }
                throw new ViessmannError('LOGIN_FAILED', { detail }, { statusCode: res.status });
            }

            // Redirect to a login or consent page instead of the redirect URI
            throw new ViessmannError('INTERACTIVE_LOGIN_REQUIRED', { redirectUri },
                { statusCode: res.status, body: location });
        }

        const text = await res.text().catch(() => '');
        const json = parseJson(text);
        const detail = (json && (json.error_description || json.message || json.error)) ||
            (text && text.length < 300 ? text.trim() : '') || `HTTP ${res.status}`;

        // Viessmann answers a wrong redirect URI directly with an error message
        // ("Invalid redirection URI") instead of a redirect.
        if (/redirect/i.test(detail) || /redirect/i.test(text)) {
            throw new ViessmannError('REDIRECT_URI_MISMATCH', { detail, redirectUri },
                { statusCode: res.status, body: json || text });
        }
        if (res.status === 200) {
            throw new ViessmannError('INTERACTIVE_LOGIN_REQUIRED', { redirectUri },
                { statusCode: 200, body: text.slice(0, 500) });
        }
        throw new ViessmannError('LOGIN_FAILED', { detail }, { statusCode: res.status, body: json || text });
    }

    /**
     * Login step 2: exchange the code for access and refresh token.
     * Equivalent to the "set payload & headers" node of the original flow.
     */
    async exchangeAuthorizationCode({ code, codeChallenge, redirectUri }) {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.clientId,
            redirect_uri: (redirectUri || this.redirectUri).trim(),
            code_verifier: codeChallenge,
            code
        }).toString();

        const res = await this._fetch(`${this.iamHost}/idp/v3/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const text = await res.text();
        const json = parseJson(text);

        if (!res.ok || !json || !json.access_token) {
            const detail = (json && (json.error_description || json.message || json.error)) || '-';
            throw new ViessmannError('CODE_EXCHANGE_FAILED', { status: res.status, detail },
                { statusCode: res.status, body: json || text });
        }
        this._applyTokens(json);
        return json;
    }

    /** Complete login: get the code and redeem it. */
    async login() {
        const { code, codeChallenge } = await this.requestAuthorizationCode();
        const tokens = await this.exchangeAuthorizationCode({ code, codeChallenge });
        this.lastLoginAt = nowMs();
        this.log('info', 'Automatic Viessmann login successful.');
        return tokens;
    }

    /* ------------------------------------------------------------------ *
     * HTTP basics
     * ------------------------------------------------------------------ */

    async _fetch(url, init) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeout);
        try {
            return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                throw new ViessmannError('TIMEOUT', { ms: this.timeout, url: url.split('?')[0] });
            }
            throw new ViessmannError('NETWORK', { detail: err && err.message ? err.message : String(err) });
        } finally {
            clearTimeout(timer);
        }
    }

    /** Authenticated API call with exactly one retry after HTTP 401. */
    async request(path, { method = 'GET', body = null, retryOn401 = true } = {}) {
        const token = await this.getAccessToken();
        const headers = { Authorization: `Bearer ${token}` };
        let payload;
        if (body !== null && body !== undefined) {
            headers['Content-Type'] = 'application/json';
            payload = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const url = path.startsWith('http') ? path : `${this.apiHost}${path}`;
        const res = await this._fetch(url, { method, headers, body: payload });

        if (res.status === 401 && retryOn401) {
            this.log('debug', 'HTTP 401 – renewing token and retrying');
            await this.getAccessToken(true);
            return this.request(path, { method, body, retryOn401: false });
        }

        const text = await res.text();
        const json = parseJson(text);

        if (res.status === 429) {
            const retryAfter = Number(res.headers.get && res.headers.get('retry-after')) || null;
            throw new ViessmannError('RATE_LIMIT', {}, { statusCode: 429, body: json || text, retryAfter });
        }
        if (!res.ok) {
            const detail = (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
            throw new ViessmannError('HTTP_ERROR', { status: res.status, detail },
                { statusCode: res.status, body: json || text });
        }
        return json;
    }

    /* ------------------------------------------------------------------ *
     * Equipment / auto-discovery
     * ------------------------------------------------------------------ */

    async getInstallations() {
        const r = await this.request('/iot/v2/equipment/installations');
        return (r && r.data) || [];
    }

    async getGateways() {
        const r = await this.request('/iot/v2/equipment/gateways');
        return (r && r.data) || [];
    }

    async getDevices(installationId, gatewaySerial) {
        const r = await this.request(
            `/iot/v2/equipment/installations/${installationId}/gateways/${gatewaySerial}/devices`
        );
        return (r && r.data) || [];
    }

    /** Determines installation, gateway and device; fixed values win. */
    async resolveTargets({ installationId, gatewaySerial, deviceId, force = false } = {}) {
        if (this._targets && !force && !installationId && !gatewaySerial && deviceId === undefined) {
            return this._targets;
        }

        let inst = installationId;
        let gw = gatewaySerial;
        let dev = deviceId;

        if (!inst) {
            const installations = await this.getInstallations();
            if (!installations.length) throw new ViessmannError('NO_INSTALLATION');
            inst = installations[0].id;
        }
        if (!gw) {
            const gateways = await this.getGateways();
            if (!gateways.length) throw new ViessmannError('NO_GATEWAY');
            const match = gateways.find((g) => String(g.installationId) === String(inst));
            gw = (match || gateways[0]).serial;
        }
        if (dev === undefined || dev === null || dev === '') {
            let devices = [];
            try {
                devices = await this.getDevices(inst, gw);
            } catch (err) {
                this.log('warn', `Device list not available (${err.message}) – using deviceId "0".`);
            }
            // "0" is practically always the controller on Vitoconnect systems.
            dev = devices.length ? devices[0].id : '0';
        }

        this._targets = { installationId: String(inst), gatewaySerial: String(gw), deviceId: String(dev) };
        return this._targets;
    }

    /* ------------------------------------------------------------------ *
     * Features
     * ------------------------------------------------------------------ */

    featuresPath(t) {
        return `/iot/v2/features/installations/${t.installationId}` +
               `/gateways/${t.gatewaySerial}/devices/${t.deviceId}/features`;
    }

    async getFeatures(targets) {
        const t = targets || await this.resolveTargets();
        const r = await this.request(this.featuresPath(t));
        return (r && r.data) || [];
    }

    async getFeature(featureName, targets) {
        const t = targets || await this.resolveTargets();
        const r = await this.request(`${this.featuresPath(t)}/${encodeURIComponent(featureName)}`);
        return (r && r.data) || null;
    }

    async executeCommand(featureName, commandName, params = {}, targets) {
        const t = targets || await this.resolveTargets();
        const path = `${this.featuresPath(t)}/${encodeURIComponent(featureName)}` +
                     `/commands/${encodeURIComponent(commandName)}`;
        return this.request(path, { method: 'POST', body: params || {} });
    }
}

module.exports = {
    ViessmannApi,
    ViessmannError,
    generateCodeChallenge,
    isValidCodeChallenge,
    DEFAULT_API_HOST,
    DEFAULT_IAM_HOST,
    DEFAULT_REDIRECT_URI
};
