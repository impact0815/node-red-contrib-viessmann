#!/usr/bin/env node
/**
 * Leichtgewichtige Prüfung ohne externe Werkzeuge: Syntax aller Quelldateien
 * und Editor-Skripte, Vollständigkeit der Editor-Bausteine, Pflichtangaben für
 * die Node-RED-Palette, Gültigkeit der Beispiel-Flows und dass keine
 * Zugangsdaten in den Beispielen stecken.
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
// Node-RED verlangt für neue Pakete einen Scope, z. B. @benutzer/node-red-contrib-xyz
/^@[a-z0-9-]+\/node-red-/.test(pkg.name) ? ok('Name mit Scope') : bad('Name entspricht nicht den Node-RED-Richtlinien (@scope/node-red-…)');
(pkg.keywords || []).includes('node-red') ? ok('Schlüsselwort node-red') : bad('Schlüsselwort "node-red" fehlt');
pkg.license ? ok('license') : bad('license fehlt');
pkg.repository ? ok('repository') : bad('repository fehlt');
(pkg.publishConfig && pkg.publishConfig.access === 'public') ? ok('publishConfig.access = public') : bad('publishConfig.access "public" fehlt');
for (const [name, file] of Object.entries((pkg['node-red'] || {}).nodes || {})) {
    const js = path.join(root, file);
    fs.existsSync(js) && fs.existsSync(js.replace(/\.js$/, '.html')) ? ok(name) : bad(name + ': Datei fehlt');
}
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
changelog.includes(`[${pkg.version}]`) ? ok(`CHANGELOG enthält ${pkg.version}`) : bad(`CHANGELOG ohne Eintrag für ${pkg.version}`);
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
/no warranty/i.test(readme) && /eigene Gefahr/i.test(readme) ? ok('Haftungsausschluss in README') : bad('Haftungsausschluss in README fehlt');

console.log('Beispiel-Flows:');
const known = new Set(['viessmann-config', 'viessmann-read', 'viessmann-write']);
for (const f of fs.readdirSync(path.join(root, 'examples')).filter((x) => x.endsWith('.json'))) {
    try {
        const flow = JSON.parse(fs.readFileSync(path.join(root, 'examples', f), 'utf8'));
        if (!Array.isArray(flow)) throw new Error('muss ein Array sein');
        const ids = new Set(flow.map((n) => n.id));
        const dangling = flow.flatMap((n) => (n.wires || []).flat()).filter((w) => !ids.has(w));
        if (dangling.length) throw new Error('Verbindung zu unbekannter Node: ' + dangling.join(', '));
        if (flow.some((n) => n.credentials)) throw new Error('enthält Zugangsdaten');
        for (const n of flow.filter((x) => x.func)) new vm.Script('(function(){' + n.func + '\n})', { filename: f + ':' + n.name });
        const vmNodes = flow.filter((n) => known.has(n.type)).length;
        ok(`${f} (${flow.length} Knoten, ${vmNodes} Viessmann)`);
    } catch (e) { bad(f + ': ' + e.message); }
}

if (failed) { console.error(`\n${failed} Problem(e) gefunden.`); process.exit(1); }
console.log('\nAlles in Ordnung.');
