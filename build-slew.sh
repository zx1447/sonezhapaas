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

# Ship the agent inside the bundle. The runner mounts /tmp noexec, so the
# cdn-utils loader (download to tmpdir + dlopen) gets EPERM, and the runner is
# musl-based so the glibc-built module can't relocate. The official static
# binary (v2.4.0, CGO off) works on musl: it ships in-repo and the app spawns
# it with a config written to the writable tmpdir.
cp nezha-agent out/server/nezha-agent
chmod +x out/server/nezha-agent

printf '{"server":"server/index.js","runtime":"node22"}\n' > out/slew.json

echo "=== artifact ==="
du -sh out out/server/node_modules
ls out out/server
cp nagent out/server/nagent
