/**
 * Lese-Node: holt Datenpunkte von der Viessmann-API, filtert sie und gibt sie
 * im gewünschten Format aus.
 *
 * Ausgang 1: Daten
 * Ausgang 2: Status/Fehler (bewusst getrennt, damit nachgelagerte Logik nie
 *            eine Fehlermeldung für einen Messwert hält)
 */

'use strict';

const featuresLib = require('../lib/features');

module.exports = function (RED) {
    function ViessmannReadNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);
        node.selection = config.selection || 'all';          // all | selected | pattern
        node.features = Array.isArray(config.features) ? config.features : [];
        node.pattern = config.pattern || '';
        node.outputFormat = config.outputFormat || 'object'; // object | flat | split | raw
        node.onlyAvailable = config.onlyAvailable !== false;
        node.topicPrefix = config.topicPrefix || 'viessmann';
        node.interval = Math.max(0, Number(config.interval) || 0);       // Sekunden, 0 = nur auf Eingang
        node.startupDelay = Math.max(0, Number(config.startupDelay) || 10);
        node.staleAfter = Math.max(0, Number(config.staleAfter) || 900); // Sekunden
        node.forceRefresh = config.forceRefresh === true;

        let timer = null;
        let startTimer = null;
        let lastOk = 0;
        let lastAlarm = '';

        if (!node.server) {
            node.status({ fill: 'red', shape: 'ring', text: 'keine Konfiguration' });
            return;
        }

        const ts = () => new Date().toLocaleTimeString('de-DE');

        function selectFeatures(list, msg) {
            let selected = list;
            if (node.selection === 'selected') {
                const wanted = (msg && Array.isArray(msg.features)) ? msg.features : node.features;
                selected = featuresLib.filterFeatures(list, wanted);
            } else if (node.selection === 'pattern') {
                const pattern = (msg && typeof msg.pattern === 'string' && msg.pattern) || node.pattern;
                selected = featuresLib.filterFeatures(list, pattern.split(',').map((s) => s.trim()));
            }
            if (node.onlyAvailable) selected = selected.filter((f) => f.available);
            return selected;
        }

        function buildMessages(selected, list, msg) {
            const base = RED.util.cloneMessage(msg || {});
            if (node.outputFormat === 'split') {
                return selected.map((f) => {
                    const m = RED.util.cloneMessage(base);
                    m.topic = `${node.topicPrefix}/${f.feature}`;
                    m.feature = f.feature;
                    m.payload = (Object.keys(f.values).length === 1 && f.values.value !== undefined)
                        ? f.values.value : f.values;
                    m.viessmann = { units: f.units, timestamp: f.timestamp, deprecated: f.deprecated, writable: f.writable };
                    return m;
                });
            }
            if (node.outputFormat === 'flat') {
                base.payload = featuresLib.flatten(selected, { includeEmpty: !node.onlyAvailable });
            } else if (node.outputFormat === 'raw') {
                base.payload = node.server.getRawFeatures();
            } else {
                base.payload = featuresLib.toMap(selected);
            }
            base.topic = base.topic || node.topicPrefix;
            base.viessmann = {
                retrievedAt: new Date().toISOString(),
                count: selected.length,
                summary: featuresLib.summarize(list)
            };
            return [base];
        }

        async function poll(msg, send, done) {
            try {
                const force = node.forceRefresh || (msg && msg.refresh === true);
                const list = await node.server.getFeatures({ force });
                const selected = selectFeatures(list, msg);

                lastOk = Date.now();
                if (lastAlarm) {
                    // Nur bei Zustandswechsel melden, nicht in jedem Zyklus.
                    lastAlarm = '';
                    send([null, { topic: `${node.topicPrefix}/status`, payload: { ok: true, message: 'Verbindung wiederhergestellt' } }]);
                }

                for (const m of buildMessages(selected, list, msg)) send([m, null]);

                const s = featuresLib.summarize(list);
                node.status({ fill: 'green', shape: 'dot', text: `${ts()}: ${selected.length} Werte (${s.available}/${s.total} verfügbar)` });
                if (done) done();
            } catch (err) {
                const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
                const stale = node.staleAfter > 0 && lastOk > 0 && (Date.now() - lastOk) > node.staleAfter * 1000;
                const signature = `${err.code || 'ERR'}:${err.message}`;

                if (signature !== lastAlarm) {
                    lastAlarm = signature;
                    send([null, {
                        topic: `${node.topicPrefix}/status`,
                        payload: {
                            ok: false,
                            error: err.message,
                            code: err.code || null,
                            statusCode: err.statusCode || null,
                            retryAfter: err.retryAfter || null,
                            lastSuccessAgeSeconds: age,
                            stale
                        }
                    }]);
                }
                node.status({ fill: stale || !lastOk ? 'red' : 'yellow', shape: 'ring', text: `${ts()}: ${err.message}`.slice(0, 90) });
                if (done) done();
            }
        }

        node.on('input', (msg, send, done) => poll(msg, send, done));

        if (node.interval > 0) {
            startTimer = setTimeout(() => {
                const send = (m) => node.send(m);
                poll({}, send, null);
                timer = setInterval(() => poll({}, send, null), node.interval * 1000);
            }, node.startupDelay * 1000);
            node.status({ fill: 'grey', shape: 'ring', text: `Start in ${node.startupDelay}s` });
        } else {
            node.status({ fill: 'grey', shape: 'ring', text: 'bereit' });
        }

        node.on('close', function (done) {
            if (timer) clearInterval(timer);
            if (startTimer) clearTimeout(startTimer);
            timer = null;
            startTimer = null;
            done();
        });
    }

    RED.nodes.registerType('viessmann-read', ViessmannReadNode);
};
