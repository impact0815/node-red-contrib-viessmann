/**
 * Error and validation texts (English defaults).
 *
 * Every error carries a stable `key` and `params`. Node-RED nodes translate
 * the key through their message catalogs (nodes/locales/<lang>/...), so the
 * same error appears in German or English depending on the Node-RED language.
 * The English texts here are the fallback and are used outside Node-RED.
 *
 * Placeholders use the Node-RED/i18next syntax __name__.
 */

'use strict';

const ERRORS = {
    NO_CLIENT_ID: 'No client ID configured.',
    NO_CREDENTIALS: 'Credentials incomplete. Please enter client ID, ViCare user name and password.',
    TOKEN_REFRESH_FAILED: 'Token refresh failed (HTTP __status__).',
    BAD_CODE_CHALLENGE: 'Invalid code challenge: 43 to 128 characters from letters, digits and "-._~" are allowed. Leave the field empty to have one generated automatically.',
    LOGIN_REJECTED: 'Login rejected (HTTP 401): ViCare user name or password is wrong.',
    REDIRECT_URI_MISMATCH: 'Viessmann rejects the redirect URI (__detail__). Sent: "__redirectUri__". It must exactly match one of the addresses stored for the client in the Viessmann Developer Portal (http/https, host name, port, path and trailing slash).',
    INTERACTIVE_LOGIN_REQUIRED: 'Viessmann requires an interactive login. Most common causes: Google reCAPTCHA is still enabled for this client in the Viessmann Developer Portal, the user name or password is wrong, or the redirect URI "__redirectUri__" does not match the one stored there.',
    LOGIN_FAILED: 'Login failed: __detail__',
    UNEXPECTED_REDIRECT: 'Unexpected redirect: __location__',
    CODE_EXCHANGE_FAILED: 'Redeeming the authorization code failed (HTTP __status__): __detail__',
    TIMEOUT: 'Timeout after __ms__ ms: __url__',
    NETWORK: 'Network error: __detail__',
    RATE_LIMIT: 'Viessmann API rate limit reached (HTTP 429). Increase the polling interval.',
    HTTP_ERROR: 'API error (HTTP __status__): __detail__',
    NO_INSTALLATION: 'No installation found. Is the system registered in the ViCare app?',
    NO_GATEWAY: 'No gateway found (is the Vitoconnect online?).'
};

const VALIDATION = {
    UNKNOWN_COMMAND: 'Unknown command.',
    NOT_EXECUTABLE: 'Command "__command__" is currently not executable (isExecutable=false).',
    REQUIRED: 'Required parameter "__name__" is missing.',
    NOT_A_NUMBER: 'Parameter "__name__" must be a number (received: __value__).',
    BELOW_MIN: '"__name__" = __value__ is below the minimum __min__.',
    ABOVE_MAX: '"__name__" = __value__ is above the maximum __max__.',
    STEPPING: '"__name__" = __value__ does not match the step size __step__.',
    NOT_A_STRING: 'Parameter "__name__" must be a string.',
    NOT_ALLOWED: '"__name__" = "__value__" is not allowed. Allowed: __allowed__.',
    TOO_SHORT: '"__name__" is too short (min. __min__).',
    TOO_LONG: '"__name__" is too long (max. __max__).',
    PATTERN: '"__name__" does not match the pattern __pattern__.',
    NOT_BOOLEAN: 'Parameter "__name__" must be true or false.',
    UNKNOWN_PARAM: 'Unknown parameter "__name__". Allowed: __allowed__.'
};

/** Replaces __name__ placeholders. Unknown placeholders stay visible. */
function format(template, params) {
    return String(template).replace(/__(\w+)__/g, (m, k) =>
        (params && params[k] !== undefined && params[k] !== null) ? String(params[k]) : m);
}

/** Error with a translatable key and machine-readable context. */
class ViessmannError extends Error {
    /**
     * @param {string} key     message key from ERRORS
     * @param {object} [params] placeholder values
     * @param {object} [extra]  { code, statusCode, body, retryAfter }
     */
    constructor(key, params = {}, extra = {}) {
        super(format(ERRORS[key] || key, params));
        this.name = 'ViessmannError';
        this.key = key;
        this.params = params;
        this.code = extra.code || key;
        this.statusCode = extra.statusCode;
        this.body = extra.body;
        this.retryAfter = extra.retryAfter;
    }
}

module.exports = { ERRORS, VALIDATION, format, ViessmannError };
