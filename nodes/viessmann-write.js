/**
 * Write node: executes commands of the Viessmann API.
 *
 * Safety principles:
 *   1. Writing is disabled by default and must be allowed explicitly in the
 *      configuration.
 *   2. Parameters are checked against the value ranges delivered by the API
 *      before anything is sent.
 *   3. Nothing is written if the target value is already set.
 *   4. A minimum interval between writes prevents loops.
 *   5. Responses use their own output, separate from measured values.
 */

'use strict';

const featuresLib = require('../lib/features');
const { VALIDATION } = require('../lib/errors');

module.exports = function (RED) {
    const t = (key, params) => RED._('viessmann-write.' + key, params || {});

    /** Translates a validation problem; falls back to the English text. */
    function translateProblem(p) {
        if (!VALIDATION[p.key]) return p.message;
        const full = 'viessmann-write.validation.' + p.key;
        const text = RED._(full, p.params || {});
        return (text && text !== full) ? text : p.message;
    }

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
            node.status({ fill: 'red', shape: 'ring', text: t('status.noServer') });
            return;
        }

        const ts = () => new Date().toLocaleTimeString();

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
                    const e = new Error(t('error.BAD_PARAMS', { detail: err.message }));
                    e.code = 'BAD_PARAMS';
                    throw e;
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
                return fail(msg, send, done, t('error.WRITE_DISABLED'), { code: 'WRITE_DISABLED' });
            }
            if (!featureName || !commandName) {
                return fail(msg, send, done, t('error.MISSING_TARGET'), { code: 'MISSING_TARGET' });
            }

            const rate = node.server.checkWriteRate();
            if (!rate.ok) {
                return fail(msg, send, done, t('error.RATE_GUARD', { s: Math.ceil(rate.waitMs / 1000) }),
                    { code: 'RATE_GUARD', waitMs: rate.waitMs });
            }

            let params;
            try {
                params = resolveParams(msg);
            } catch (err) {
                return fail(msg, send, done, err.message, { code: 'BAD_PARAMS' });
            }

            try {
                // Always read fresh: validation and comparison need the actual
                // state, not an old cache entry.
                const map = featuresLib.toMap(await node.server.getFeatures({ force: true }));
                const feature = map[featureName];

                if (!feature) {
                    return fail(msg, send, done, t('error.UNKNOWN_FEATURE', { feature: featureName }),
                        { code: 'UNKNOWN_FEATURE' });
                }
                if (!feature.isEnabled) {
                    return fail(msg, send, done, t('error.FEATURE_DISABLED', { feature: featureName }),
                        { code: 'FEATURE_DISABLED' });
                }

                const command = feature.commands.find((c) => c.name === commandName);
                if (!command) {
                    const names = feature.commands.map((c) => c.name);
                    return fail(msg, send, done,
                        t('error.UNKNOWN_COMMAND', { command: commandName, feature: featureName, available: names.join(', ') || '-' }),
                        { code: 'UNKNOWN_COMMAND', availableCommands: names });
                }

                const check = featuresLib.validateCommandParams(command, params);
                if (!check.valid) {
                    const errors = check.problems.map(translateProblem);
                    return fail(msg, send, done, errors.join(' '),
                        { code: 'VALIDATION_FAILED', errors, constraints: command.params });
                }

                const cmp = featuresLib.currentValueForCommand(feature, commandName, check.params);
                if (node.skipIfUnchanged && cmp.known && cmp.equal) {
                    return result(msg, send, done, {
                        ok: true, skipped: true, reason: t('result.skipped'),
                        feature: featureName, command: commandName,
                        current: cmp.current, desired: cmp.desired
                    }, { fill: 'blue', shape: 'dot', text: t('status.unchanged', { time: ts() }) });
                }

                if (node.dryRun) {
                    return result(msg, send, done, {
                        ok: true, dryRun: true, feature: featureName, command: commandName,
                        params: check.params, current: cmp.known ? cmp.current : undefined
                    }, { fill: 'yellow', shape: 'dot', text: t('status.dryRun', { time: ts() }) });
                }

                const response = await node.server.api.executeCommand(featureName, commandName, check.params);
                node.server.markWrite();
                node.server.invalidateCache();

                return result(msg, send, done, {
                    ok: true, skipped: false, feature: featureName, command: commandName,
                    params: check.params, previous: cmp.known ? cmp.current : undefined,
                    response: response || null
                }, { fill: 'green', shape: 'dot', text: t('status.ok', { time: ts(), command: commandName }) });
            } catch (err) {
                fail(msg, send, done, node.server.translateError(err), {
                    code: err.code || 'REQUEST_FAILED',
                    statusCode: err.statusCode || null,
                    retryAfter: err.retryAfter || null,
                    details: err.body || null
                });
            }
        });

        node.status({ fill: 'grey', shape: 'ring', text: node.server.allowWrite ? t('status.ready') : t('status.locked') });
    }

    RED.nodes.registerType('viessmann-write', ViessmannWriteNode);
};
