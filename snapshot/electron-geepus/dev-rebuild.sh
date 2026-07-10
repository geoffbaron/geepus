#!/bin/bash
cd "$(dirname "$0")"

echo "=== Geepus Hot-Rebuild ==="
echo "1. Bumping patch version..."
npm version patch

echo "2. Killing running instances..."
killall Geepus 2>/dev/null || true

echo "3. Repackaging..."
npx electron-packager . Geepus --platform=darwin --arch=arm64 --out=dist --overwrite

echo "4. Re-launching..."
open dist/Geepus-darwin-arm64/Geepus.app

echo "Done!"
