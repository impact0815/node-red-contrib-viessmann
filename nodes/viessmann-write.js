/**
 * Schreib-Node: führt Befehle der Viessmann-API aus.
 *
 * Sicherheitsprinzipien:
 *   1. Schreiben ist standardmäßig aus und muss in der Konfiguration
 *      ausdrücklich freigegeben werden.
 *   2. Parameter werden gegen die von der API gelieferten Wertebereiche
 *      geprüft, bevor überhaupt gesendet wird.
 *   3. Es wird nicht geschrieben, wenn der Zielwert bereits anliegt.
 *   4. Ein Mindestabstand zwischen Schreibvorgängen verhindert Schleifen.
 *   5. Antworten laufen über einen eigenen Ausgang, getrennt von Messwerten.
 */

'use strict';

const featuresLib = require('../lib/features');

module.exports = function (RED) {
    function ViessmannWriteNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.server = RED.nodes.getNode(config.server);
        node.feature = config.feature || '';
        node.command = config.command || '';
        node.paramSource = config.paramSource || 'payload'; // payload | fixed
        node.fixedParams = config.fixedParams || '';
        node.skipIfUnchanged = config.skipIfUnchanged !== false;
        node.dryRun = config.dryRun === true;
        node.topicPrefix = config.topicPrefix || 'viessmann';

        if (!node.server) {
            node.status({ fill: 'red', shape: 'ring', text: 'keine Konfiguration' });
            return;
        }

        const ts = () => new Date().toLocaleTimeString('de-DE');

        function result(msg, send, done, payload, status) {
            const out = RED.util.cloneMessage(msg);
            out.topic = `${node.topicPrefix}/write/result`;
            out.payload = payload;
            send([out, null]);
            node.status(status);
            if (done) done();
        }

        function fail(msg, send, done, text, extra) {
            const out = RED.util.cloneMessage(msg);
            out.topic = `${node.topicPrefix}/write/error`;
            out.payload = Object.assign({ ok: false, error: text }, extra || {});
            send([null, out]);
            node.status({ fill: 'red', shape: 'ring', text: `${ts()}: ${text}`.slice(0, 90) });
            if (done) done();
        }

        function resolveParams(msg) {
            if (msg && msg.params && typeof msg.params === 'object') return msg.params;
            if (node.paramSource === 'fixed' && node.fixedParams) {
                try {
                    return JSON.parse(node.fixedParams);
                } catch (err) {
                    throw new Error('Feste Parameter sind kein gültiges JSON: ' + err.message);
                }
            }
            if (msg && msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)) {
                return msg.payload;
            }
            return {};
        }

        node.on('input', async function (msg, send, done) {
            const featureName = (msg && msg.feature) || node.feature;
            const commandName = (msg && msg.command) || node.command;

            if (!node.server.allowWrite) {
                return fail(msg, send, done,
                    'Schreiben ist deaktiviert. In der Viessmann-Konfiguration "Schreibzugriff erlauben" aktivieren.',
                    { code: 'WRITE_DISABLED' });
            }
            if (!featureName || !commandName) {
                return fail(msg, send, done,
                    'Datenpunkt und Befehl fehlen. Entweder im Node hinterlegen oder per msg.feature / msg.command setzen.',
                    { code: 'MISSING_TARGET' });
            }

            const rate = node.server.checkWriteRate();
            if (!rate.ok) {
                return fail(msg, send, done,
                    `Mindestabstand zwischen Schreibvorgängen nicht eingehalten (noch ${Math.ceil(rate.waitMs / 1000)}s).`,
                    { code: 'RATE_GUARD', waitMs: rate.waitMs });
            }

            let params;
            try {
                params = resolveParams(msg);
            } catch (err) {
                return fail(msg, send, done, err.message, { code: 'BAD_PARAMS' });
            }

            try {
                // Immer frisch lesen: Validierung und Vergleich brauchen den
                // tatsächlichen Zustand, nicht einen alten Cache-Eintrag.
                const map = featuresLib.toMap(await node.server.getFeatures({ force: true }));
                const feature = map[featureName];

                if (!feature) {
                    return fail(msg, send, done, `Datenpunkt "${featureName}" existiert an diesem Gerät nicht.`,
                        { code: 'UNKNOWN_FEATURE' });
                }
                if (!feature.isEnabled) {
                    return fail(msg, send, done,
                        `Datenpunkt "${featureName}" wird von diesem Gerät nicht unterstützt (isEnabled=false).`,
                        { code: 'FEATURE_DISABLED' });
                }

                const command = feature.commands.find((c) => c.name === commandName);
                if (!command) {
                    const names = feature.commands.map((c) => c.name);
                    return fail(msg, send, done,
                        `Befehl "${commandName}" gibt es für "${featureName}" nicht. Verfügbar: ${names.join(', ') || '(keine)'}.`,
                        { code: 'UNKNOWN_COMMAND', availableCommands: names });
                }

                const check = featuresLib.validateCommandParams(command, params);
                if (!check.valid) {
                    return fail(msg, send, done, check.errors.join(' '),
                        { code: 'VALIDATION_FAILED', errors: check.errors, constraints: command.params });
                }

                const cmp = featuresLib.currentValueForCommand(feature, commandName, check.params);
                if (node.skipIfUnchanged && cmp.known && cmp.equal) {
                    return result(msg, send, done, {
                        ok: true, skipped: true,
                        reason: 'Zielwert liegt bereits an – es wurde nichts geschrieben.',
                        feature: featureName, command: commandName,
                        current: cmp.current, desired: cmp.desired
                    }, { fill: 'blue', shape: 'dot', text: `${ts()}: unverändert` });
                }

                if (node.dryRun) {
                    return result(msg, send, done, {
                        ok: true, dryRun: true, feature: featureName, command: commandName,
                        params: check.params, current: cmp.known ? cmp.current : undefined
                    }, { fill: 'yellow', shape: 'dot', text: `${ts()}: Testlauf` });
                }

                const response = await node.server.api.executeCommand(featureName, commandName, check.params);
                node.server.markWrite();
                node.server.invalidateCache();

                return result(msg, send, done, {
                    ok: true, skipped: false, feature: featureName, command: commandName,
                    params: check.params, previous: cmp.known ? cmp.current : undefined,
                    response: response || null
                }, { fill: 'green', shape: 'dot', text: `${ts()}: ${commandName} ok` });
            } catch (err) {
                fail(msg, send, done, err.message, {
                    code: err.code || 'REQUEST_FAILED',
                    statusCode: err.statusCode || null,
                    retryAfter: err.retryAfter || null,
                    details: err.body || null
                });
            }
        });

        node.status({ fill: 'grey', shape: 'ring', text: node.server.allowWrite ? 'bereit' : 'Schreiben gesperrt' });
    }

    RED.nodes.registerType('viessmann-write', ViessmannWriteNode);
};
