/**
 * Minimal Node-RED stand-in for the node tests.
 *
 * Each node file gets its own RED object whose RED._() resolves keys from the
 * real message catalog of that node (nodes/locales/<lang>/<file>.json) – just
 * like Node-RED scopes RED._() per node. This way the tests also check that
 * the translations exist and that placeholders are filled.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const NODES = ['viessmann-config', 'viessmann-read', 'viessmann-write'];

function loadCatalog(name, lang) {
    const file = path.join(__dirname, '..', 'nodes', 'locales', lang, name + '.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function translator(catalog) {
    return (key, params = {}) => {
        const value = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), catalog);
        if (typeof value !== 'string') return key;
        return value.replace(/__(\w+)__/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
    };
}

function makeRED(lang = 'en-US') {
    const types = {};
    const instances = {};
    const routes = { get: {}, post: {} };
    const RED = {
        types, routes, credentialsWritten: [],
        nodes: {
            createNode(node, config) {
                node.id = config.id;
                node.type = config.type;
                node.credentials = config.credentials || {};
                node._handlers = {};
                node.on = (ev, fn) => { node._handlers[ev] = fn; };
                node.status = (s) => { node._status = s; };
                node.send = () => {};
                node.error = () => {};
                node.warn = () => {};
                node.log = () => {};
                node.debug = () => {};
                instances[node.id] = node;
            },
            registerType(name, ctor) { types[name] = ctor; },
            getNode(id) { return instances[id] || null; },
            addCredentials(id, creds) { RED.credentialsWritten.push({ id, creds }); }
        },
        util: { cloneMessage: (m) => JSON.parse(JSON.stringify(m || {})) },
        httpAdmin: {
            get(p, ...h) { routes.get[p] = h[h.length - 1]; },
            post(p, ...h) { routes.post[p] = h[h.length - 1]; }
        },
        auth: { needsPermission: () => (req, res, next) => next && next() }
    };
    for (const name of NODES) {
        const mod = '../nodes/' + name;
        delete require.cache[require.resolve(mod)];
        const scoped = Object.create(RED);
        scoped._ = translator(loadCatalog(name, lang));
        require(mod)(scoped);
    }
    return RED;
}

module.exports = { makeRED, loadCatalog, NODES };
