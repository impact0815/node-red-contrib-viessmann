#!/usr/bin/env node
/**
 * Lightweight check without external tools: syntax of all source files and
 * editor scripts, completeness of the editor parts, locale files, required
 * fields for the Node-RED palette, validity of the example flows and that no
 * credentials are contained in the examples.
 *
 * (Translation consistency is checked in test/i18n.test.js.)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const NODES = ['viessmann-config', 'viessmann-read', 'viessmann-write'];
const DEFAULT_LOCALE = 'en-US';
const LANGS = [DEFAULT_LOCALE, 'de'];
let failed = 0;
const ok = (m) => console.log('  ok     ' + m);
const bad = (m) => { console.error('  ERROR  ' + m); failed++; };

console.log('Source files:');
for (const f of ['lib/api.js', 'lib/errors.js', 'lib/features.js', ...NODES.map((n) => `nodes/${n}.js`)]) {
    try { new vm.Script(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }); ok(f); }
    catch (e) { bad(f + ': ' + e.message); }
}

console.log('Editor files:');
for (const n of NODES) {
    const f = `nodes/${n}.html`;
    const html = fs.readFileSync(path.join(root, f), 'utf8');
    const m = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
    if (!m) { bad(f + ': no editor script'); continue; }
    try { new vm.Script(m[1], { filename: f }); } catch (e) { bad(f + ': ' + e.message); continue; }
    if (!html.includes(`data-template-name="${n}"`)) { bad(f + ': edit template missing'); continue; }
    ok(f);
}

console.log('Locales:');
for (const lang of LANGS) {
    for (const n of NODES) {
        for (const ext of ['json', 'html']) {
            const f = `nodes/locales/${lang}/${n}.${ext}`;
            const p = path.join(root, f);
            if (!fs.existsSync(p)) { bad(f + ' missing'); continue; }
            if (ext === 'json') {
                try { JSON.parse(fs.readFileSync(p, 'utf8')); ok(f); } catch (e) { bad(f + ': ' + e.message); }
            } else {
                const help = fs.readFileSync(p, 'utf8');
                if (!help.includes(`data-help-name="${n}"`)) { bad(f + ': data-help-name missing'); continue; }
                const firstHeading = help.match(/<h3>([^<]+)<\/h3>/);
                const expected = lang === DEFAULT_LOCALE ? 'Disclaimer' : 'Haftungsausschluss';
                firstHeading && firstHeading[1] === expected
                    ? ok(f)
                    : bad(f + ': disclaimer must be the first help section');
            }
        }
    }
}

console.log('Package:');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
/^@[a-z0-9-]+\/node-red-/.test(pkg.name) ? ok('scoped name') : bad('name must follow @scope/node-red-… (Node-RED guidelines)');
(pkg.keywords || []).includes('node-red') ? ok('keyword node-red') : bad('keyword "node-red" missing');
pkg.license ? ok('license') : bad('license missing');
pkg.repository ? ok('repository') : bad('repository missing');
(pkg.publishConfig && pkg.publishConfig.access === 'public') ? ok('publishConfig.access = public') : bad('publishConfig.access "public" missing');
for (const [name, file] of Object.entries((pkg['node-red'] || {}).nodes || {})) {
    const js = path.join(root, file);
    fs.existsSync(js) && fs.existsSync(js.replace(/\.js$/, '.html')) ? ok(name) : bad(name + ': file missing');
}
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
changelog.includes(`[${pkg.version}]`) ? ok(`CHANGELOG contains ${pkg.version}`) : bad(`CHANGELOG has no entry for ${pkg.version}`);
for (const [f, rx, heading] of [
    ['README.md', /no warranty/i, 'Disclaimer'],
    ['README.de.md', /eigene Gefahr/i, 'Haftungsausschluss']
]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) { bad(`${f} missing`); continue; }
    const readme = fs.readFileSync(p, 'utf8');
    const firstSection = readme.match(/^## (.+)$/m);
    rx.test(readme) && firstSection && firstSection[1] === heading
        ? ok(`${f} with disclaimer first`)
        : bad(`${f} missing disclaimer or disclaimer is not first`);
}

console.log('Example flows:');
const known = new Set(NODES);
for (const f of fs.readdirSync(path.join(root, 'examples')).filter((x) => x.endsWith('.json'))) {
    try {
        const flow = JSON.parse(fs.readFileSync(path.join(root, 'examples', f), 'utf8'));
        if (!Array.isArray(flow)) throw new Error('must be an array');
        const ids = new Set(flow.map((n) => n.id));
        const dangling = flow.flatMap((n) => (n.wires || []).flat()).filter((w) => !ids.has(w));
        if (dangling.length) throw new Error('wire to unknown node: ' + dangling.join(', '));
        if (flow.some((n) => n.credentials)) throw new Error('contains credentials');
        for (const n of flow.filter((x) => x.func)) new vm.Script('(function(){' + n.func + '\n})', { filename: f + ':' + n.name });
        ok(`${f} (${flow.length} nodes, ${flow.filter((n) => known.has(n.type)).length} Viessmann)`);
    } catch (e) { bad(f + ': ' + e.message); }
}

if (failed) { console.error(`\n${failed} problem(s) found.`); process.exit(1); }
console.log('\nAll good.');
