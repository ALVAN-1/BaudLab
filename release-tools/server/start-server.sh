#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22.13+ is required. Install an LTS release from nodejs.org.' >&2
  exit 1
fi
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22 || (v[0]===22 && v[1]<13)) process.exit(1); require('node:sqlite');"
exec node server.js
