#!/bin/sh
# Netlify builds Petti from this repository on every push (alongside GitHub Pages): the same build stamp as
# .github/workflows, so one page load only ever sees one version of the app.
set -e
V=$(printf '%s' "${COMMIT_REF:-dev}" | cut -c1-8)
sed -i "s/__BUILD__/$V/g" sw.js
sed -i "s|js/app.js\"|js/app.js?v=$V\"|" index.html
sed -i -E "s#(from '(\./|\.\./)[^']+\.js)'#\1?v=$V'#g; s#(import\('(\./|\.\./)[^']+\.js)'\)#\1?v=$V')#g" js/*.js js/pages/*.js
echo "Petti build $V"
