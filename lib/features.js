/**
 * Processing of Viessmann data points ("features").
 *
 * Core idea: no device delivers all data points. Instead of maintaining a
 * fixed list, everything is derived from the API response – including the
 * write commands and their value ranges. This also works with devices that
 * did not exist when this package was written.
 *
 * Important fields per feature:
 *   isEnabled   – device supports the feature (false = not present)
 *   isReady     – feature is operational
 *   properties  – values/states, per property { type, value, unit }
 *   commands    – executable commands incl. params.constraints
 *   deprecated  – hint about successor and removal date
 */

'use strict';

const { VALIDATION, format } = require('./errors');

/** Extracts the successor from a deprecation hint. */
function parseReplacement(info) {
    if (!info || typeof info !== 'string') return null;
    const m = info.match(/replaced by\s+([A-Za-z0-9._]+)/i);
    return m ? m[1] : null;
}

/** Turns a raw feature into a flat, easy-to-use shape. */
function normalizeFeature(raw) {
    const properties = {};
    const values = {};
    const units = {};

    const rawProps = (raw && raw.properties) || {};
    for (const [key, prop] of Object.entries(rawProps)) {
        if (!prop || typeof prop !== 'object') continue;
        properties[key] = { value: prop.value, unit: prop.unit || null, type: prop.type || null };
        values[key] = prop.value;
        if (prop.unit) units[key] = prop.unit;
    }

    const commands = [];
    const rawCmds = (raw && raw.commands) || {};
    for (const [name, cmd] of Object.entries(rawCmds)) {
        if (!cmd || typeof cmd !== 'object') continue;
        commands.push({
            name,
            executable: cmd.isExecutable !== false,
            params: cmd.params || {},
            uri: cmd.uri || null
        });
    }

    const hasProps = Object.keys(properties).length > 0;

    return {
        feature: raw ? raw.feature : undefined,
        deviceId: raw ? raw.deviceId : undefined,
        gatewayId: raw ? raw.gatewayId : undefined,
        timestamp: raw ? raw.timestamp : undefined,
        isEnabled: raw ? raw.isEnabled !== false : false,
        isReady: raw ? raw.isReady !== false : false,
        // "available" = supported by the device AND filled with content.
        // This separates "device cannot do this" from "value currently empty".
        available: Boolean(raw && raw.isEnabled !== false && hasProps),
        empty: !hasProps,
        deprecated: raw && raw.deprecated ? {
            removalDate: raw.deprecated.removalDate || null,
            info: raw.deprecated.info || null,
            replacedBy: parseReplacement(raw.deprecated.info)
        } : null,
        properties,
        values,
        units,
        commands,
        writable: commands.some((c) => c.executable)
    };
}

function normalizeFeatures(rawList) {
    return (Array.isArray(rawList) ? rawList : []).map(normalizeFeature);
}

/** Builds a map featureName -> normalized feature. */
function toMap(list) {
    const map = {};
    for (const f of list) {
        if (f && f.feature) map[f.feature] = f;
    }
    return map;
}

/**
 * Reduces features to plain key/value pairs – ideal for MQTT, dashboards or
 * databases. Single-value features ("value" only) are stored under the
 * feature name, multi-value ones as "feature.property".
 */
function flatten(list, { includeEmpty = false, separator = '.' } = {}) {
    const out = {};
    for (const f of list) {
        if (!f || !f.feature) continue;
        if (!includeEmpty && !f.available) continue;
        const keys = Object.keys(f.values);
        if (keys.length === 1 && keys[0] === 'value') {
            out[f.feature] = f.values.value;
            continue;
        }
        for (const k of keys) out[`${f.feature}${separator}${k}`] = f.values[k];
    }
    return out;
}

/** Filters by glob patterns like "heating.dhw.*" or exact names. */
function matchesPattern(name, pattern) {
    if (!pattern || pattern === '*' || pattern === '**') return true;
    if (!pattern.includes('*') && !pattern.includes('?')) return name === pattern;
    const rx = new RegExp('^' + pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$');
    return rx.test(name);
}

function filterFeatures(list, patterns) {
    const pats = (Array.isArray(patterns) ? patterns : [patterns])
        .filter((p) => typeof p === 'string' && p.trim() !== '');
    if (!pats.length) return list;
    return list.filter((f) => pats.some((p) => matchesPattern(f.feature, p)));
}

/** Groups by the prefix of the feature names (heating, device, ventilation …). */
function groupFeatures(list, depth = 1) {
    const groups = {};
    for (const f of list) {
        if (!f || !f.feature) continue;
        const key = f.feature.split('.').slice(0, depth).join('.');
        (groups[key] = groups[key] || []).push(f);
    }
    return groups;
}

/**
 * Checks parameters against the constraints delivered by the API.
 *
 * Every problem is returned as { key, params, message } – the key is
 * translated by the write node, the message is the English fallback.
 *
 * @returns {{valid: boolean, errors: string[], problems: object[], params: object}}
 */
function validateCommandParams(command, params = {}) {
    const problems = [];
    const add = (key, p = {}) => problems.push({ key, params: p, message: format(VALIDATION[key], p) });

    if (!command) {
        add('UNKNOWN_COMMAND');
        return { valid: false, problems, errors: problems.map((x) => x.message), params };
    }
    if (command.executable === false) add('NOT_EXECUTABLE', { command: command.name });

    const spec = command.params || {};
    const cleaned = {};

    for (const [name, def] of Object.entries(spec)) {
        if (!Object.prototype.hasOwnProperty.call(params, name)) {
            if (def.required) add('REQUIRED', { name });
            continue;
        }
        let value = params[name];
        const c = def.constraints || {};

        if (def.type === 'number') {
            const num = typeof value === 'string' ? Number(value) : value;
            if (typeof num !== 'number' || Number.isNaN(num)) {
                add('NOT_A_NUMBER', { name, value: JSON.stringify(value) });
                continue;
            }
            if (c.min !== undefined && num < c.min) add('BELOW_MIN', { name, value: num, min: c.min });
            if (c.max !== undefined && num > c.max) add('ABOVE_MAX', { name, value: num, max: c.max });
            if (c.stepping) {
                const steps = (num - (c.min !== undefined ? c.min : 0)) / c.stepping;
                if (Math.abs(steps - Math.round(steps)) > 1e-6) add('STEPPING', { name, value: num, step: c.stepping });
            }
            value = num;
        } else if (def.type === 'string') {
            if (typeof value !== 'string') {
                add('NOT_A_STRING', { name });
                continue;
            }
            if (Array.isArray(c.enum) && !c.enum.includes(value)) {
                add('NOT_ALLOWED', { name, value, allowed: c.enum.join(', ') });
            }
            if (c.minLength !== undefined && value.length < c.minLength) add('TOO_SHORT', { name, min: c.minLength });
            if (c.maxLength !== undefined && value.length > c.maxLength) add('TOO_LONG', { name, max: c.maxLength });
            if (c.regEx) {
                let rx = null;
                try { rx = new RegExp(c.regEx); } catch (_) { rx = null; }
                if (rx && !rx.test(value)) add('PATTERN', { name, pattern: c.regEx });
            }
        } else if (def.type === 'boolean') {
            if (typeof value !== 'boolean') {
                add('NOT_BOOLEAN', { name });
                continue;
            }
        }
        // Other types (e.g. "Schedule") are passed through unchanged.
        cleaned[name] = value;
    }

    for (const name of Object.keys(params)) {
        if (!Object.prototype.hasOwnProperty.call(spec, name)) {
            add('UNKNOWN_PARAM', { name, allowed: Object.keys(spec).join(', ') || '-' });
        }
    }

    return {
        valid: problems.length === 0,
        problems,
        errors: problems.map((x) => x.message),
        params: cleaned
    };
}

/** Compares two schedules independent of key and entry order. */
function sameSchedule(a, b) {
    const norm = (s) => {
        const out = {};
        for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
            out[day] = ((s && s[day]) || []).map((e) => `${e.start}-${e.end}-${e.mode}`).sort();
        }
        return JSON.stringify(out);
    };
    return norm(a) === norm(b);
}

/**
 * Determines the current value a command would set – for the
 * "only write when something changes" behavior.
 */
function currentValueForCommand(feature, commandName, params = {}) {
    if (!feature) return { known: false };
    const v = feature.values || {};

    if (/^set(Target)?Temperature$/i.test(commandName)) {
        const desired = params.temperature !== undefined ? params.temperature : params.targetTemperature;
        const current = v.temperature !== undefined ? v.temperature : v.value;
        if (desired !== undefined && current !== undefined) {
            return { known: true, current, desired, equal: Number(current) === Number(desired) };
        }
    }
    if (/^setMode$/i.test(commandName) && params.mode !== undefined && v.value !== undefined) {
        return { known: true, current: v.value, desired: params.mode, equal: v.value === params.mode };
    }
    if (/^setCurve$/i.test(commandName) && v.slope !== undefined && v.shift !== undefined) {
        const equal = Number(v.slope) === Number(params.slope) && Number(v.shift) === Number(params.shift);
        return { known: true, current: { slope: v.slope, shift: v.shift }, desired: { slope: params.slope, shift: params.shift }, equal };
    }
    if (/^setSchedule$/i.test(commandName) && v.entries !== undefined && params.newSchedule !== undefined) {
        return { known: true, current: v.entries, desired: params.newSchedule, equal: sameSchedule(v.entries, params.newSchedule) };
    }
    if (/^activate$/i.test(commandName) && v.active !== undefined && Object.keys(params).length === 0) {
        return { known: true, current: v.active, desired: true, equal: v.active === true };
    }
    if (/^deactivate$/i.test(commandName) && v.active !== undefined) {
        return { known: true, current: v.active, desired: false, equal: v.active === false };
    }
    if (/^setName$/i.test(commandName) && v.name !== undefined && params.name !== undefined) {
        return { known: true, current: v.name, desired: params.name, equal: v.name === params.name };
    }
    return { known: false };
}

function summarize(list) {
    const total = list.length;
    const available = list.filter((f) => f.available).length;
    const writable = list.filter((f) => f.available && f.writable).length;
    const deprecated = list.filter((f) => f.available && f.deprecated).length;
    return { total, available, unavailable: total - available, writable, deprecated };
}

module.exports = {
    normalizeFeature, normalizeFeatures, toMap, flatten, filterFeatures, matchesPattern,
    groupFeatures, validateCommandParams, currentValueForCommand, sameSchedule, summarize, parseReplacement
};
