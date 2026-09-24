#!/bin/sh
# Bundles preview.tsx with BB's installed theme CSS and this plugin's
# compiled Tailwind (run `bb plugin build .` first so dist/app.css is fresh).
set -e
cd "$(dirname "$0")/.."
mkdir -p preview/out
npx esbuild preview/preview.tsx --bundle --outfile=preview/out/preview.js \
  --alias:@=. --jsx=automatic --define:process.env.NODE_ENV='"production"' --log-level=warning
BB_CSS=$(ls /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/app/dist/assets/index-*.css | head -1)
cp "$BB_CSS" preview/out/bb.css
cp dist/app.css preview/out/app.css
cat > preview/out/index.html <<'HTML'
<!doctype html>
<html class="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="bb.css"><link rel="stylesheet" href="app.css">
</head><body><div id="root" data-bb-plugin="env-panel"></div><script src="preview.js"></script></body></html>
HTML
