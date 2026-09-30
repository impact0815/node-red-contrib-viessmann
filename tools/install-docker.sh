#!/usr/bin/env bash
# Installiert bzw. aktualisiert node-red-contrib-viessmann in einem
# Node-RED-Docker-Container und startet ihn neu.
#
#   ./tools/install-docker.sh [containername]      (Standard: node-red)

set -euo pipefail

CONTAINER="${1:-node-red}"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_NAME="node-red-contrib-viessmann"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "FEHLER: Container '$CONTAINER' läuft nicht. Laufende Container:"
    docker ps --format '  {{.Names}}'
    exit 1
fi

echo "1/4  Dateien in den Container kopieren ..."
docker exec "$CONTAINER" rm -rf "/data/$PKG_NAME"
docker cp "$PKG_DIR" "$CONTAINER:/data/$PKG_NAME"

echo "2/4  Im Container installieren ..."
docker exec "$CONTAINER" npm install --prefix /data "/data/$PKG_NAME"

echo "3/4  Container neu starten ..."
docker restart "$CONTAINER" >/dev/null

echo "4/4  Auf den Start warten ..."
sleep 8
docker logs --tail 30 "$CONTAINER" | grep -iE "viessmann|error|started" || true

echo
echo "Fertig. Editor im Browser mit Strg+F5 neu laden, dann in der Viessmann-Konfiguration"
echo "Client-ID, Redirect-URI, ViCare-Benutzer und -Passwort eintragen und 'Verbindung testen' klicken."
