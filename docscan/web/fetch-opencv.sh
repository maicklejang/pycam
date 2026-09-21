#!/bin/sh
# Fetch the OpenCV.js build used by the web app into web/vendor/.
#
# The file is ~13 MB, so it is not stored in the repository.  Run this once
# before serving the app locally; the deploy workflow runs it as well.
set -eu

VERSION="5.0.0-release.1"
TARGET="$(dirname "$0")/vendor/opencv.js"
URL="https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${VERSION}/dist/opencv.js"

if [ -f "$TARGET" ]; then
    echo "already present: $TARGET"
    exit 0
fi

mkdir -p "$(dirname "$TARGET")"
if command -v npm >/dev/null 2>&1 && [ "${DOCSCAN_PREFER_CURL:-}" != "1" ]; then
    # npm registry access is often allowed where a CDN is not
    TEMP="$(mktemp -d)"
    trap 'rm -rf "$TEMP"' EXIT
    (cd "$TEMP" && npm pack "@techstark/opencv-js@${VERSION}" >/dev/null)
    tar -xzf "$TEMP"/*.tgz -C "$TEMP" package/dist/opencv.js
    cp "$TEMP/package/dist/opencv.js" "$TARGET"
else
    curl -fsSL "$URL" -o "$TARGET"
fi

echo "fetched $TARGET ($(wc -c < "$TARGET") bytes)"
