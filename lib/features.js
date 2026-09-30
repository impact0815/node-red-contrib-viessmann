/**
 * Aufbereitung der Viessmann-Datenpunkte ("Features").
 *
 * Kernidee: Kein Gerät liefert alle Datenpunkte. Statt eine feste Liste zu
 * pflegen, wird alles aus der Antwort der API abgeleitet – inklusive der
 * Schreibbefehle und ihrer Wertebereiche. Damit funktioniert das Paket auch
 * mit Geräten, die es beim Erstellen noch gar nicht gab.
 *
 * Wichtige Felder der API pro Feature:
 *   isEnabled   – Gerät unterstützt das Feature (false = nicht vorhanden)
 *   isReady     – Feature ist betriebsbereit
 *   properties  – Messwerte/Zustände, je Eigenschaft { type, value, unit }
 *   commands    – ausführbare Befehle inkl. params.constraints
 *   deprecated  – Hinweis auf Nachfolger und Abschaltdatum
 */

'use strict';

/** Extrahiert den Nachfolger aus einem deprecated-Hinweis. */
function parseReplacement(info) {
    if (!info || typeof info !== 'string') return null;
    const m = info.match(/replaced by\s+([A-Za-z0-9._]+)/i);
    return m ? m[1] : null;
}

/** Bringt ein Roh-Feature in eine flache, gut verwendbare Form. */
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
        // "available" = vom Gerät unterstützt UND mit Inhalt gefüllt.
        // Genau hier trennt sich "Gerät kann das nicht" von "Wert gerade leer".
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

/** Baut eine Map featureName -> normalisiertes Feature. */
function toMap(list) {
    const map = {};
    for (const f of list) {
        if (f && f.feature) map[f.feature] = f;
    }
    return map;
}

/**
 * Reduziert Features auf schlichte Schlüssel/Wert-Paare – ideal für MQTT,
 * Dashboards oder Datenbanken. Einzelwert-Features (nur "value") landen direkt
 * unter dem Feature-Namen, mehrwertige als "feature.eigenschaft".
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

/** Filtert nach Glob-Mustern wie "heating.dhw.*" oder exakten Namen. */
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

/** Gruppiert nach dem Präfix der Feature-Namen (heating, device, ventilation …). */
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
 * Prüft Parameter gegen die von der API gelieferten Constraints.
 * @returns {{valid: boolean, errors: string[], params: object}}
 */
function validateCommandParams(command, params = {}) {
    const errors = [];
    if (!command) return { valid: false, errors: ['Befehl unbekannt.'], params };
    if (command.executable === false) {
        errors.push(`Befehl "${command.name}" ist laut API derzeit nicht ausführbar (isExecutable=false).`);
    }

    const spec = command.params || {};
    const cleaned = {};

    for (const [name, def] of Object.entries(spec)) {
        if (!Object.prototype.hasOwnProperty.call(params, name)) {
            if (def.required) errors.push(`Pflichtparameter "${name}" fehlt.`);
            continue;
        }
        let value = params[name];
        const c = def.constraints || {};

        if (def.type === 'number') {
            const num = typeof value === 'string' ? Number(value) : value;
            if (typeof num !== 'number' || Number.isNaN(num)) {
                errors.push(`Parameter "${name}" muss eine Zahl sein (erhalten: ${JSON.stringify(value)}).`);
                continue;
            }
            if (c.min !== undefined && num < c.min) errors.push(`"${name}" = ${num} liegt unter dem Minimum ${c.min}.`);
            if (c.max !== undefined && num > c.max) errors.push(`"${name}" = ${num} liegt über dem Maximum ${c.max}.`);
            if (c.stepping) {
                const steps = (num - (c.min !== undefined ? c.min : 0)) / c.stepping;
                if (Math.abs(steps - Math.round(steps)) > 1e-6) {
                    errors.push(`"${name}" = ${num} passt nicht zur Schrittweite ${c.stepping}.`);
                }
            }
            value = num;
        } else if (def.type === 'string') {
            if (typeof value !== 'string') {
                errors.push(`Parameter "${name}" muss eine Zeichenkette sein.`);
                continue;
            }
            if (Array.isArray(c.enum) && !c.enum.includes(value)) {
                errors.push(`"${name}" = "${value}" ist nicht erlaubt. Zulässig: ${c.enum.join(', ')}.`);
            }
            if (c.minLength !== undefined && value.length < c.minLength) errors.push(`"${name}" ist zu kurz (min. ${c.minLength}).`);
            if (c.maxLength !== undefined && value.length > c.maxLength) errors.push(`"${name}" ist zu lang (max. ${c.maxLength}).`);
            if (c.regEx) {
                let rx = null;
                try { rx = new RegExp(c.regEx); } catch (_) { rx = null; }
                if (rx && !rx.test(value)) errors.push(`"${name}" entspricht nicht dem Muster ${c.regEx}.`);
            }
        } else if (def.type === 'boolean') {
            if (typeof value !== 'boolean') {
                errors.push(`Parameter "${name}" muss true oder false sein.`);
                continue;
            }
        }
        cleaned[name] = value;
    }

    for (const name of Object.keys(params)) {
        if (!Object.prototype.hasOwnProperty.call(spec, name)) {
            errors.push(`Unbekannter Parameter "${name}". Erlaubt: ${Object.keys(spec).join(', ') || '(keine)'}.`);
        }
    }

    return { valid: errors.length === 0, errors, params: cleaned };
}

/**
 * Ermittelt den aktuellen Wert, den ein Befehl setzen würde – für das
 * "Nur schreiben, wenn sich etwas ändert"-Verhalten.
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
    groupFeatures, validateCommandParams, currentValueForCommand, summarize, parseReplacement
};
