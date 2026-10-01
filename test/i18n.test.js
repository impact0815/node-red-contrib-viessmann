/**
 * Consistency of the translations.
 *
 * Makes sure that English and German never drift apart:
 *   - both catalogs of every node have exactly the same keys,
 *   - every translation uses the same placeholders as its counterpart,
 *   - every key used in the editor (data-i18n, this._()) and in the runtime
 *     (RED._, t()) exists,
 *   - every error and validation key of lib/errors.js is translated,
 *   - every node has a help file in both languages.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ERRORS, VALIDATION } = require('../lib/errors');
const { loadCatalog, NODES } = require('./red-mock');

const LANGS = ['en-US', 'de'];
const root = path.join(__dirname, '..');

function flatKeys(obj, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object') Object.assign(out, flatKeys(v, key));
        else out[key] = v;
    }
    return out;
}

const placeholders = (s) => (String(s).match(/__\w+__/g) || []).sort().join(',');

for (const name of NODES) {
    const cats = Object.fromEntries(LANGS.map((l) => [l, flatKeys(loadCatalog(name, l))]));

    test(`${name}: English and German catalogs have the same keys`, () => {
        assert.deepStrictEqual(Object.keys(cats.de).sort(), Object.keys(cats['en-US']).sort());
    });

    test(`${name}: translations use the same placeholders`, () => {
        for (const key of Object.keys(cats['en-US'])) {
            assert.strictEqual(placeholders(cats.de[key]), placeholders(cats['en-US'][key]), key);
        }
    });

    test(`${name}: all keys used in editor and runtime exist`, () => {
        const html = fs.readFileSync(path.join(root, 'nodes', name + '.html'), 'utf8');
        const js = fs.readFileSync(path.join(root, 'nodes', name + '.js'), 'utf8');
        const used = new Set();
        for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) {
            for (const part of m[1].split(';')) used.add(part.replace(/^\s*\[[^\]]+\]/, '').trim());
        }
        for (const m of html.matchAll(/_\('([\w.-]+)'/g)) used.add(m[1]);
        // runtime: t('key') is prefixed with the node namespace
        for (const m of js.matchAll(/\bt\('([\w.]+)'/g)) used.add(`${name}.${m[1]}`);
        for (const key of used) {
            if (key.endsWith('.')) continue; // dynamic prefix, e.g. 'runtime.errors.' + key
            assert.ok(cats['en-US'][key] !== undefined, `missing key ${key}`);
        }
    });

    test(`${name}: help text exists in both languages`, () => {
        for (const lang of LANGS) {
            const help = fs.readFileSync(path.join(root, 'nodes', 'locales', lang, name + '.html'), 'utf8');
            assert.ok(help.includes(`data-help-name="${name}"`), `${lang}/${name}.html`);
        }
        const main = fs.readFileSync(path.join(root, 'nodes', name + '.html'), 'utf8');
        assert.ok(!main.includes('data-help-name'), 'help must live in locales/, not in the main html');
    });
}

test('every error key of lib/errors.js is translated', () => {
    for (const lang of LANGS) {
        const cat = flatKeys(loadCatalog('viessmann-config', lang));
        for (const key of Object.keys(ERRORS)) {
            assert.ok(cat[`viessmann-config.runtime.errors.${key}`], `${lang}: ${key}`);
        }
    }
});

test('every validation key is translated', () => {
    for (const lang of LANGS) {
        const cat = flatKeys(loadCatalog('viessmann-write', lang));
        for (const key of Object.keys(VALIDATION)) {
            assert.ok(cat[`viessmann-write.validation.${key}`], `${lang}: ${key}`);
        }
    }
});

test('the English catalog matches the English defaults in lib/errors.js', () => {
    const cfg = loadCatalog('viessmann-config', 'en-US')['viessmann-config'].runtime.errors;
    const wr = loadCatalog('viessmann-write', 'en-US')['viessmann-write'].validation;
    assert.deepStrictEqual(cfg, ERRORS);
    assert.deepStrictEqual(wr, VALIDATION);
});
