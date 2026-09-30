#!/usr/bin/env node
/**
 * Leichtgewichtige Prüfung ohne externe Werkzeuge: Syntax aller Quelldateien
 * und Editor-Skripte, Vollständigkeit der Editor-Bausteine, Pflichtangaben für
 * die Node-RED-Palette und Gültigkeit der Beispiel-Flows.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let failed = 0;
const ok = (m) => console.log('  ok     ' + m);
const bad = (m) => { console.error('  FEHLER ' + m); failed++; };

console.log('Quelldateien:');
for (const f of ['lib/api.js', 'lib/features.js', 'nodes/viessmann-config.js', 'nodes/viessmann-read.js', 'nodes/viessmann-write.js']) {
    try { new vm.Script(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }); ok(f); }
    catch (e) { bad(f + ': ' + e.message); }
}

console.log('Editor-Dateien:');
for (const f of ['nodes/viessmann-config.html', 'nodes/viessmann-read.html', 'nodes/viessmann-write.html']) {
    const html = fs.readFileSync(path.join(root, f), 'utf8');
    const m = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
    if (!m) { bad(f + ': kein Editor-Skript'); continue; }
    try { new vm.Script(m[1], { filename: f }); } catch (e) { bad(f + ': ' + e.message); continue; }
    if (!html.includes('data-template-name')) { bad(f + ': Eingabemaske fehlt'); continue; }
    if (!html.includes('data-help-name')) { bad(f + ': Hilfetext fehlt'); continue; }
    ok(f);
}

console.log('Paketangaben:');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
/^node-red-contrib-/.test(pkg.name) ? ok('Name') : bad('Name folgt nicht der Konvention node-red-contrib-*');
(pkg.keywords || []).includes('node-red') ? ok('Schlüsselwort node-red') : bad('Schlüsselwort "node-red" fehlt');
pkg.license ? ok('license') : bad('license fehlt');
pkg.repository ? ok('repository') : bad('repository fehlt');
for (const [name, file] of Object.entries((pkg['node-red'] || {}).nodes || {})) {
    const js = path.join(root, file);
    fs.existsSync(js) && fs.existsSync(js.replace(/\.js$/, '.html')) ? ok(name) : bad(name + ': Datei fehlt');
}

console.log('Beispiel-Flows:');
for (const f of fs.readdirSync(path.join(root, 'examples')).filter((x) => x.endsWith('.json'))) {
    try {
        const flow = JSON.parse(fs.readFileSync(path.join(root, 'examples', f), 'utf8'));
        if (!Array.isArray(flow)) throw new Error('muss ein Array sein');
        ok(`${f} (${flow.length} Knoten)`);
    } catch (e) { bad(f + ': ' + e.message); }
}

if (failed) { console.error(`\n${failed} Problem(e) gefunden.`); process.exit(1); }
console.log('\nAlles in Ordnung.');
