/**
 * Read node: fetches data points from the Viessmann API, filters them and
 * outputs them in the selected format.
 *
 * Output 1: data
 * Output 2: status/errors (deliberately separate so downstream logic never
 *           mistakes an error message for a measured value)
 */

'use strict';

const featuresLib = require('../lib/features');

module.exports = function (RED) {
    const t = (key, params) => RED._('viessmann-read.' + key, params || {});

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
        node.interval = Math.max(0, Number(config.interval) || 0);       // seconds, 0 = on input only
        node.startupDelay = Math.max(0, Number(config.startupDelay) || 10);
        node.staleAfter = Math.max(0, Number(config.staleAfter) || 900); // seconds
        node.forceRefresh = config.forceRefresh === true;

        let timer = null;
        let startTimer = null;
        let lastOk = 0;
        let lastAlarm = '';

        if (!node.server) {
            node.status({ fill: 'red', shape: 'ring', text: t('status.noServer') });
            return;
        }

        const ts = () => new Date().toLocaleTimeString();

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
                    // Report state changes only, not every cycle.
                    lastAlarm = '';
                    send([null, { topic: `${node.topicPrefix}/status`, payload: { ok: true, message: t('status.restored') } }]);
                }

                for (const m of buildMessages(selected, list, msg)) send([m, null]);

                const s = featuresLib.summarize(list);
                node.status({ fill: 'green', shape: 'dot',
                    text: t('status.ok', { time: ts(), count: selected.length, available: s.available, total: s.total }) });
                if (done) done();
            } catch (err) {
                const text = node.server.translateError(err);
                const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
                const stale = node.staleAfter > 0 && lastOk > 0 && (Date.now() - lastOk) > node.staleAfter * 1000;
                const signature = `${err.code || 'ERR'}:${err.message}`;

                if (signature !== lastAlarm) {
                    lastAlarm = signature;
                    send([null, {
                        topic: `${node.topicPrefix}/status`,
                        payload: {
                            ok: false,
                            error: text,
                            code: err.code || null,
                            statusCode: err.statusCode || null,
                            retryAfter: err.retryAfter || null,
                            lastSuccessAgeSeconds: age,
                            stale
                        }
                    }]);
                }
                node.status({ fill: stale || !lastOk ? 'red' : 'yellow', shape: 'ring', text: `${ts()}: ${text}`.slice(0, 90) });
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
            node.status({ fill: 'grey', shape: 'ring', text: t('status.startIn', { s: node.startupDelay }) });
        } else {
            node.status({ fill: 'grey', shape: 'ring', text: t('status.ready') });
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
