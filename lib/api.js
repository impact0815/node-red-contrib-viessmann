/**
 * Minimaler, abhängigkeitsfreier Client für die Viessmann IoT API.
 *
 * Grundlage für den Ablauf (Client-ID, Code Challenge, Authorization Code,
 * Refresh Token, Installation/Gateway/Device, Features) ist die hervorragende
 * Anleitung von Rustimation.eu:
 *   https://www.rustimation.eu/index.php/1_zugang_api/
 * Ohne diese Vorarbeit gäbe es dieses Node-RED-Paket nicht. Danke dafür!
 *
 * Offizielle Doku: https://api.viessmann-climatesolutions.com/documentation
 *
 * Bewusst ohne externe HTTP-Bibliothek: Node-RED läuft ab Node 18 mit
 * eingebautem fetch(). Weniger Abhängigkeiten = weniger Angriffsfläche.
 *
 * ---------------------------------------------------------------------------
 * Anmeldeablauf – vollautomatisch, ohne Browser
 * ---------------------------------------------------------------------------
 *   1. Liegt ein Refresh Token vor, wird damit ein Access Token geholt.
 *   2. Gibt es keins (Erststart) oder ist es ungültig, meldet sich der Client
 *      selbst an: GET /idp/v3/authorize mit HTTP Basic Auth (ViCare-Benutzer
 *      und -Passwort). Viessmann antwortet mit einer Weiterleitung auf die
 *      Redirect-URI, in der der Authorization Code steckt.
 *   3. Der Weiterleitung wird bewusst NICHT gefolgt. Der Code wird direkt aus
 *      dem Location-Header gelesen. Deshalb muss unter der Redirect-URI auch
 *      nichts lauschen – kein http-in-Node, kein offener Port.
 *   4. Der Code wird gegen Access- und Refresh-Token getauscht.
 *
 * Damit ist die im Original-Flow nötige Reihenfolge ("erst Refresh versuchen,
 * bei Fehlschlag neu anmelden") fest eingebaut – inklusive Erststart, bei dem
 * noch gar kein Refresh Token existiert.
 */

'use strict';

const crypto = require('crypto');

const DEFAULT_IAM_HOST = 'https://iam.viessmann-climatesolutions.com';
const DEFAULT_API_HOST = 'https://api.viessmann-climatesolutions.com';
const DEFAULT_REDIRECT_URI = 'http://localhost:1880/authcode';

/** Fehler mit maschinenlesbarem Kontext (Status, Body, Retry-Hinweis). */
class ViessmannError extends Error {
    constructor(message, opts = {}) {
        super(message);
        this.name = 'ViessmannError';
        this.statusCode = opts.statusCode;
        this.body = opts.body;
        this.retryAfter = opts.retryAfter;
        this.code = opts.code;
    }
}

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Erzeugt eine gültige Code Challenge (PKCE, Methode "plain").
 * Erlaubt sind 43–128 Zeichen aus A–Z, a–z, 0–9 und "-._~".
 */
function generateCodeChallenge() {
    return base64url(crypto.randomBytes(48)); // 64 Zeichen
}

/** Prüft eine vom Nutzer vorgegebene Code Challenge. */
function isValidCodeChallenge(value) {
    return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

function nowMs() {
    return Date.now();
}

class ViessmannApi {
    /**
     * @param {object} opts
     * @param {string} opts.clientId        Client-ID aus dem Viessmann Developer Dashboard
     * @param {string} [opts.username]      ViCare-Benutzername (E-Mail)
     * @param {string} [opts.password]      ViCare-Passwort
     * @param {string} [opts.codeChallenge] PKCE Code Challenge (leer = automatisch)
     * @param {string} [opts.redirectUri]   Muss exakt der im Dashboard hinterlegten entsprechen
     * @param {string} [opts.refreshToken]  Vorhandenes Refresh Token (optional)
     * @param {string} [opts.iamHost]       Basis-URL des Identity Providers
     * @param {string} [opts.apiHost]       Basis-URL der IoT-API
     * @param {number} [opts.timeout]       Timeout je Request in ms (Default 20000)
     * @param {function} [opts.log]         log(level, message) für Diagnose
     * @param {function} [opts.onTokens]    Callback bei neuem Refresh Token
     * @param {function} [opts.fetchImpl]   Injizierbares fetch (für Tests)
     */
    constructor(opts = {}) {
        this.clientId = opts.clientId;
        this.username = opts.username || '';
        this.password = opts.password || '';
        this.codeChallenge = opts.codeChallenge || '';
        this.redirectUri = opts.redirectUri || DEFAULT_REDIRECT_URI;
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
        this._tokenPromise = null; // Single-Flight: nie zwei parallele Token-Requests
        this._targets = null;      // gecachte Installation/Gateway/Device
    }

    get canLogin() {
        return Boolean(this.clientId && this.username && this.password);
    }

    /* ------------------------------------------------------------------ *
     * Token-Handling
     * ------------------------------------------------------------------ */

    /**
     * Liefert ein gültiges Access Token. Erneuert automatisch 60 s vor Ablauf.
     * @param {boolean} [force] erzwingt eine Erneuerung (z. B. nach HTTP 401)
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
     * Die zentrale Reihenfolge:
     *   Refresh Token vorhanden → erneuern.
     *   Kein Refresh Token oder Erneuerung abgelehnt → automatisch neu anmelden.
     */
    async _obtainAccessToken() {
        if (!this.clientId) {
            throw new ViessmannError('Keine Client-ID konfiguriert.', { code: 'NO_CLIENT_ID' });
        }

        if (this.refreshToken) {
            try {
                return await this._refreshAccessToken();
            } catch (err) {
                // Nur bei "Token ungültig" neu anmelden. Netzwerkfehler oder
                // Zeitüberschreitungen würden durch eine Anmeldung nicht besser.
                const rejected = err.code === 'TOKEN_REFRESH_FAILED' &&
                    [400, 401, 403].includes(err.statusCode);
                if (!rejected || !this.canLogin) throw err;
                this.log('warn', 'Refresh Token abgelehnt – melde mich automatisch neu an.');
                this.refreshToken = '';
            }
        }

        if (!this.canLogin) {
            throw new ViessmannError(
                'Anmeldedaten unvollständig. Bitte Client-ID, ViCare-Benutzername und Passwort eintragen.',
                { code: 'NO_CREDENTIALS' }
            );
        }
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
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* bleibt null */ }

        if (!res.ok || !json || !json.access_token) {
            throw new ViessmannError(
                `Token-Erneuerung fehlgeschlagen (HTTP ${res.status}).`,
                { statusCode: res.status, body: json || text, code: 'TOKEN_REFRESH_FAILED' }
            );
        }

        this._applyTokens(json);
        this.log('debug', `Access Token erneuert, gültig für ${Number(json.expires_in) || 3600}s`);
        return this.accessToken;
    }

    _applyTokens(json) {
        this.accessToken = json.access_token || null;
        this.accessTokenExpiresAt = nowMs() + (Number(json.expires_in) || 3600) * 1000;

        // Viessmann rotiert das Refresh Token nicht zwingend – wenn doch,
        // wird der neue Wert übernommen und nach außen gemeldet.
        if (json.refresh_token && json.refresh_token !== this.refreshToken) {
            this.refreshToken = json.refresh_token;
            try { this.onTokens({ refreshToken: json.refresh_token }); } catch (_) { /* egal */ }
        }
    }

    /** Baut die Autorisierungs-URL. */
    buildAuthorizeUrl({ redirectUri, codeChallenge, scope = 'IoT User offline_access' } = {}) {
        const q = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: redirectUri || this.redirectUri,
            response_type: 'code',
            code_challenge: codeChallenge || this.codeChallenge,
            scope
        });
        return `${this.iamHost}/idp/v3/authorize?${q.toString()}`;
    }

    /**
     * Schritt 1 der Anmeldung: Authorization Code per Benutzer/Passwort holen.
     * Entspricht dem "Init Auth"-Node im Original-Flow – nur dass der
     * Weiterleitung nicht gefolgt, sondern der Code direkt ausgelesen wird.
     *
     * @returns {Promise<{code: string, codeChallenge: string}>}
     */
    async requestAuthorizationCode() {
        let challenge = this.codeChallenge;
        if (!challenge) {
            challenge = generateCodeChallenge();
        } else if (!isValidCodeChallenge(challenge)) {
            throw new ViessmannError(
                'Die Code Challenge ist ungültig: erlaubt sind 43 bis 128 Zeichen aus ' +
                'Buchstaben, Ziffern und "-._~". Feld leer lassen, dann wird sie automatisch erzeugt.',
                { code: 'BAD_CODE_CHALLENGE' }
            );
        }

        const url = this.buildAuthorizeUrl({ codeChallenge: challenge });
        const basic = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');

        const res = await this._fetch(url, {
            method: 'GET',
            headers: { Authorization: `Basic ${basic}` },
            redirect: 'manual'
        });

        if (res.status === 401) {
            throw new ViessmannError(
                'Anmeldung abgelehnt (HTTP 401): ViCare-Benutzername oder Passwort falsch.',
                { statusCode: 401, code: 'LOGIN_FAILED' }
            );
        }

        const location = res.headers && res.headers.get ? res.headers.get('location') : null;

        if (res.status >= 300 && res.status < 400 && location) {
            let target;
            try {
                target = new URL(location, this.iamHost);
            } catch (_) {
                throw new ViessmannError(`Unerwartete Weiterleitung: ${location}`, { code: 'LOGIN_FAILED' });
            }

            const code = target.searchParams.get('code');
            const error = target.searchParams.get('error');

            if (code) return { code, codeChallenge: challenge };

            if (error) {
                const desc = target.searchParams.get('error_description') || error;
                const hint = /redirect/i.test(desc)
                    ? ' Die Redirect-URI muss exakt der im Viessmann-Dashboard hinterlegten entsprechen.'
                    : '';
                throw new ViessmannError(`Viessmann lehnt die Anmeldung ab: ${desc}.${hint}`, {
                    statusCode: res.status, code: 'LOGIN_FAILED'
                });
            }

            // Weiterleitung auf eine Login- oder Zustimmungsseite statt auf die Redirect-URI
            throw new ViessmannError(
                'Viessmann verlangt eine interaktive Anmeldung. Häufigste Ursachen: Google reCAPTCHA ' +
                'ist im Viessmann-Dashboard für diesen Client noch eingeschaltet, oder die Redirect-URI ' +
                'stimmt nicht mit der dort hinterlegten überein.',
                { statusCode: res.status, body: location, code: 'INTERACTIVE_LOGIN_REQUIRED' }
            );
        }

        const text = await res.text().catch(() => '');
        if (res.status === 200) {
            throw new ViessmannError(
                'Viessmann hat eine Anmeldeseite statt eines Codes geliefert. Häufigste Ursachen: ' +
                'Google reCAPTCHA ist im Viessmann-Dashboard noch eingeschaltet, oder Benutzername ' +
                'bzw. Passwort stimmen nicht.',
                { statusCode: 200, body: text.slice(0, 500), code: 'INTERACTIVE_LOGIN_REQUIRED' }
            );
        }

        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* bleibt null */ }
        const msg = (json && (json.error_description || json.message || json.error)) || `HTTP ${res.status}`;
        throw new ViessmannError(`Anmeldung fehlgeschlagen: ${msg}`, {
            statusCode: res.status, body: json || text, code: 'LOGIN_FAILED'
        });
    }

    /**
     * Schritt 2 der Anmeldung: Code gegen Access- und Refresh-Token tauschen.
     * Entspricht dem zweiten "set payload & headers"-Node im Original-Flow.
     */
    async exchangeAuthorizationCode({ code, codeChallenge, redirectUri }) {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.clientId,
            redirect_uri: redirectUri || this.redirectUri,
            code_verifier: codeChallenge,
            code
        }).toString();

        const res = await this._fetch(`${this.iamHost}/idp/v3/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* bleibt null */ }

        if (!res.ok || !json || !json.access_token) {
            const hint = (json && (json.error_description || json.message || json.error)) || '';
            throw new ViessmannError(
                `Code-Einlösung fehlgeschlagen (HTTP ${res.status})${hint ? ': ' + hint : ''}`,
                { statusCode: res.status, body: json || text, code: 'CODE_EXCHANGE_FAILED' }
            );
        }
        this._applyTokens(json);
        return json;
    }

    /** Komplette Anmeldung: Code holen und einlösen. */
    async login() {
        const { code, codeChallenge } = await this.requestAuthorizationCode();
        const tokens = await this.exchangeAuthorizationCode({ code, codeChallenge });
        this.lastLoginAt = nowMs();
        this.log('info', 'Automatische Anmeldung bei Viessmann erfolgreich.');
        return tokens;
    }

    /* ------------------------------------------------------------------ *
     * HTTP-Grundlagen
     * ------------------------------------------------------------------ */

    async _fetch(url, init) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeout);
        try {
            return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                throw new ViessmannError(`Zeitüberschreitung nach ${this.timeout} ms: ${url.split('?')[0]}`, { code: 'TIMEOUT' });
            }
            throw new ViessmannError(`Netzwerkfehler: ${err && err.message ? err.message : err}`, { code: 'NETWORK' });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Authentifizierter API-Aufruf mit einmaligem Retry nach 401.
     * @param {string} path  Pfad ab Host, z. B. /iot/v2/equipment/installations
     */
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
            this.log('debug', 'HTTP 401 – Token wird erneuert und der Aufruf wiederholt');
            await this.getAccessToken(true);
            return this.request(path, { method, body, retryOn401: false });
        }

        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* bleibt null */ }

        if (res.status === 429) {
            const retryAfter = Number(res.headers.get && res.headers.get('retry-after')) || null;
            throw new ViessmannError(
                'Rate Limit der Viessmann-API erreicht (HTTP 429). Abfrageintervall erhöhen.',
                { statusCode: 429, body: json || text, retryAfter, code: 'RATE_LIMIT' }
            );
        }
        if (!res.ok) {
            const msg = (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
            throw new ViessmannError(`API-Fehler (HTTP ${res.status}): ${msg}`, {
                statusCode: res.status, body: json || text, code: 'HTTP_ERROR'
            });
        }
        return json;
    }

    /* ------------------------------------------------------------------ *
     * Equipment / Auto-Discovery
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

    /**
     * Ermittelt Installation, Gateway und Gerät. Feste Vorgaben gewinnen,
     * fehlende Angaben werden automatisch ergänzt und gecacht.
     */
    async resolveTargets({ installationId, gatewaySerial, deviceId, force = false } = {}) {
        if (this._targets && !force && !installationId && !gatewaySerial && deviceId === undefined) {
            return this._targets;
        }

        let inst = installationId;
        let gw = gatewaySerial;
        let dev = deviceId;

        if (!inst) {
            const installations = await this.getInstallations();
            if (!installations.length) {
                throw new ViessmannError(
                    'Keine Installation gefunden. Ist die Anlage in der ViCare-App registriert?',
                    { code: 'NO_INSTALLATION' }
                );
            }
            inst = installations[0].id;
        }
        if (!gw) {
            const gateways = await this.getGateways();
            if (!gateways.length) {
                throw new ViessmannError('Kein Gateway gefunden (Vitoconnect online?).', { code: 'NO_GATEWAY' });
            }
            const match = gateways.find((g) => String(g.installationId) === String(inst));
            gw = (match || gateways[0]).serial;
        }
        if (dev === undefined || dev === null || dev === '') {
            let devices = [];
            try {
                devices = await this.getDevices(inst, gw);
            } catch (err) {
                this.log('warn', `Geräteliste nicht abrufbar (${err.message}) – verwende deviceId "0".`);
            }
            // "0" ist bei Vitoconnect-Anlagen praktisch immer der Regler.
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

    /** Liest alle Features eines Geräts (Rohform der API). */
    async getFeatures(targets) {
        const t = targets || await this.resolveTargets();
        const r = await this.request(this.featuresPath(t));
        return (r && r.data) || [];
    }

    /** Liest ein einzelnes Feature (Rohform der API). */
    async getFeature(featureName, targets) {
        const t = targets || await this.resolveTargets();
        const r = await this.request(`${this.featuresPath(t)}/${encodeURIComponent(featureName)}`);
        return (r && r.data) || null;
    }

    /**
     * Führt ein Kommando eines Features aus.
     * @param {string} featureName z. B. heating.dhw.temperature.main
     * @param {string} commandName z. B. setTargetTemperature
     * @param {object} params      z. B. { temperature: 55 }
     */
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
