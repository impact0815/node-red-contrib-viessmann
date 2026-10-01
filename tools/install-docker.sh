#!/usr/bin/env bash
# Installs or updates the package from this source folder into a Node-RED
# Docker container and restarts it. For development/testing – end users
# install via the palette or npm.
#
#   ./tools/install-docker.sh [container]      (default: node-red)

set -euo pipefail

CONTAINER="${1:-node-red}"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="/data/node-red-contrib-viessmann-src"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "ERROR: container '$CONTAINER' is not running. Running containers:"
    docker ps --format '  {{.Names}}'
    exit 1
fi

echo "1/4  Copying files into the container ..."
docker exec "$CONTAINER" rm -rf "$TARGET"
docker cp "$PKG_DIR" "$CONTAINER:$TARGET"

echo "2/4  Installing inside the container ..."
docker exec "$CONTAINER" npm install --prefix /data "$TARGET"

echo "3/4  Restarting the container ..."
docker restart "$CONTAINER" >/dev/null

echo "4/4  Waiting for startup ..."
sleep 8
docker logs --tail 30 "$CONTAINER" | grep -iE "viessmann|error|started" || true

echo
echo "Done. Reload the Node-RED editor in the browser with Ctrl+F5."
