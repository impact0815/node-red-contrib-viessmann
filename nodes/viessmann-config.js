/**
 * Konfigurations-Node: hält Zugangsdaten, meldet sich vollautomatisch bei
 * Viessmann an und stellt allen Lese- und Schreib-Nodes einen gemeinsamen
 * Datencache zur Verfügung (eine Abfrage pro Takt statt einer pro Node –
 * wichtig wegen des Rate Limits).
 *
 * Der Nutzer trägt nur ein: Client-ID, ViCare-Benutzername, ViCare-Passwort
 * und optional die Code Challenge. Alles Weitere – Authorization Code,
 * Access Token, Refresh Token, Erneuerung, erneute Anmeldung nach Ablauf –
 * erledigt die Node selbst.
 *
 * Idee und Ablauf des API-Zugangs nach https://www.rustimation.eu/index.php/1_zugang_api/
 */

'use strict';

const { ViessmannApi, DEFAULT_REDIRECT_URI } = require('../lib/api');
const featuresLib = require('../lib/features');

/** Platzhalter, den der Node-RED-Editor für bereits gespeicherte Passwörter sendet. */
const PWRD = '__PWRD__';

module.exports = function (RED) {
    function ViessmannConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name;
        node.iamHost = config.iamHost || 'https://iam.viessmann-climatesolutions.com';
        node.apiHost = config.apiHost || 'https://api.viessmann-climatesolutions.com';
        node.redirectUri = (config.redirectUri || '').trim() || DEFAULT_REDIRECT_URI;
        node.installationId = (config.installationId || '').trim();
        node.gatewaySerial = (config.gatewaySerial || '').trim();
        node.deviceId = (config.deviceId === undefined || config.deviceId === null)
            ? '' : String(config.deviceId).trim();
        node.timeout = Number(config.timeout) || 20000;
        node.cacheTtl = Math.max(0, Number(config.cacheTtl) || 30) * 1000;
        node.allowWrite = config.allowWrite === true;
        node.minWriteInterval = Math.max(0, Number(config.minWriteInterval) || 5) * 1000;

        const creds = node.credentials || {};

        node.api = new ViessmannApi({
            clientId: (creds.clientId || '').trim(),
            username: (creds.username || '').trim(),
            password: creds.password || '',
            codeChallenge: (creds.codeChallenge || '').trim(),
            refreshToken: creds.refreshToken || '',
            redirectUri: node.redirectUri,
            iamHost: node.iamHost,
            apiHost: node.apiHost,
            timeout: node.timeout,
            log: (level, msg) => {
                if (level === 'warn') node.warn(msg);
                else if (level === 'info') node.log(msg);
                else node.debug(msg);
            },
            onTokens: ({ refreshToken }) => {
                // Neues Refresh Token mitschreiben. Geht das schief, ist das kein
                // Beinbruch: Mit Benutzer und Passwort meldet sich die Node nach
                // einem Neustart einfach wieder selbst an.
                try {
                    RED.nodes.addCredentials(node.id, Object.assign({}, node.credentials, { refreshToken }));
                } catch (err) {
                    node.debug('Refresh Token nicht persistiert: ' + err.message);
                }
            }
        });

        node._cache = { at: 0, list: null, raw: null };
        node._inFlight = null;
        node._lastWriteAt = 0;

        /** Gemeinsame Zieldaten (Installation/Gateway/Gerät). */
        node.resolveTargets = function (force) {
            return node.api.resolveTargets({
                installationId: node.installationId || undefined,
                gatewaySerial: node.gatewaySerial || undefined,
                deviceId: node.deviceId !== '' ? node.deviceId : undefined,
                force: force === true
            });
        };

        /**
         * Liefert alle Datenpunkte normalisiert. Innerhalb der Cache-Zeit wird die
         * vorhandene Antwort wiederverwendet; parallele Anfragen teilen sich
         * denselben laufenden Aufruf.
         */
        node.getFeatures = async function ({ force = false } = {}) {
            const fresh = node._cache.list && (Date.now() - node._cache.at) < node.cacheTtl;
            if (fresh && !force) return node._cache.list;
            if (node._inFlight) return node._inFlight;

            node._inFlight = (async () => {
                const targets = await node.resolveTargets();
                const raw = await node.api.getFeatures(targets);
                const list = featuresLib.normalizeFeatures(raw);
                node._cache = { at: Date.now(), list, raw };
                return list;
            })().finally(() => { node._inFlight = null; });

            return node._inFlight;
        };

        node.getRawFeatures = function () {
            return node._cache.raw || [];
        };

        node.invalidateCache = function () {
            node._cache = { at: 0, list: null, raw: null };
        };

        /** Schutz vor Schreibschleifen. */
        node.checkWriteRate = function () {
            const delta = Date.now() - node._lastWriteAt;
            if (node._lastWriteAt && delta < node.minWriteInterval) {
                return { ok: false, waitMs: node.minWriteInterval - delta };
            }
            return { ok: true };
        };
        node.markWrite = function () {
            node._lastWriteAt = Date.now();
        };

        node.on('close', function (done) {
            node.invalidateCache();
            node._inFlight = null;
            done();
        });
    }

    RED.nodes.registerType('viessmann-config', ViessmannConfigNode, {
        credentials: {
            clientId: { type: 'text' },
            username: { type: 'text' },
            password: { type: 'password' },
            codeChallenge: { type: 'password' },
            refreshToken: { type: 'password' }
        }
    });

    /* ================================================================== *
     * Editor-Endpunkte
     * ================================================================== */

    function getConfigNode(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (!node || node.type !== 'viessmann-config') {
            res.status(404).json({ error: 'Konfiguration noch nicht gespeichert. Bitte einmal Deploy drücken.' });
            return null;
        }
        return node;
    }

    /**
     * Verbindungstest direkt aus dem Dialog – funktioniert auch VOR dem ersten
     * Deploy. Bereits gespeicherte Passwörter schickt der Editor nur als
     * Platzhalter; die werden durch die hinterlegten Werte ersetzt.
     */
    RED.httpAdmin.post('/viessmann/test', RED.auth.needsPermission('flows.write'), async function (req, res) {
        const b = req.body || {};
        const deployed = b.id ? RED.nodes.getNode(b.id) : null;
        const stored = (deployed && deployed.credentials) || {};
        const pick = (key) => {
            const v = b[key];
            if (v === PWRD || v === undefined || v === null) return stored[key] || '';
            return String(v);
        };

        const api = new ViessmannApi({
            clientId: pick('clientId').trim(),
            username: pick('username').trim(),
            password: pick('password'),
            codeChallenge: pick('codeChallenge').trim(),
            redirectUri: (b.redirectUri || '').trim() || DEFAULT_REDIRECT_URI,
            iamHost: (b.iamHost || '').trim() || undefined,
            apiHost: (b.apiHost || '').trim() || undefined,
            timeout: 20000
        });

        const steps = [];
        try {
            await api.login();
            steps.push('Anmeldung erfolgreich');
            const targets = await api.resolveTargets({
                installationId: (b.installationId || '').trim() || undefined,
                gatewaySerial: (b.gatewaySerial || '').trim() || undefined,
                deviceId: (b.deviceId !== undefined && String(b.deviceId).trim() !== '')
                    ? String(b.deviceId).trim() : undefined
            });
            steps.push('Anlage gefunden');
            const list = featuresLib.normalizeFeatures(await api.getFeatures(targets));
            steps.push('Datenpunkte gelesen');
            res.json({ ok: true, steps, targets, summary: featuresLib.summarize(list) });
        } catch (err) {
            res.json({ ok: false, steps, error: err.message, code: err.code || null });
        }
    });

    // Liste aller Datenpunkte des Geräts – füllt die Auswahlfelder im Editor.
    RED.httpAdmin.get('/viessmann/:id/features', RED.auth.needsPermission('flows.read'), async function (req, res) {
        const node = getConfigNode(req, res);
        if (!node) return;
        try {
            const list = await node.getFeatures({ force: req.query.refresh === 'true' });
            res.json({
                targets: await node.resolveTargets(),
                summary: featuresLib.summarize(list),
                features: list.map((f) => ({
                    feature: f.feature,
                    available: f.available,
                    isEnabled: f.isEnabled,
                    empty: f.empty,
                    writable: f.writable,
                    deprecated: f.deprecated,
                    properties: Object.keys(f.properties),
                    values: f.values,
                    units: f.units,
                    commands: f.commands.map((c) => ({ name: c.name, executable: c.executable, params: c.params }))
                }))
            });
        } catch (err) {
            res.status(500).json({ error: err.message, code: err.code || null });
        }
    });
};
