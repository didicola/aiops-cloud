#!/bin/bash
set -euo pipefail
DATE=$(date +%Y%m%d_%H%M%S)
SNAPSHOT_DIR="/tmp/eon_brain_$DATE"
mkdir -p "$SNAPSHOT_DIR"
declare -a CORE_FILES=(
  "/home/ricos/ricocoder/scripts/eon-agent.js"
  "/home/ricos/ricocoder/scripts/eon-consensus.js"
  "/home/ricos/ricocoder/scripts/eon-orchestrator.js"
  "/home/ricos/ricocoder/scripts/eon-refinement-agent.js"
  "/home/ricos/ricocoder/scripts/parallel-world-relay.js"
  "/home/ricos/ricocoder/scripts/parallel-world.sh"
  "/home/ricos/ricocoder/scripts/dream_cycle.py"
  "/home/ricos/ricocoder/scripts/tg-local-webhook.js"
  "/home/ricos/ricocoder/scripts/blind-proxy.js"
  "/home/ricos/ricocoder/scripts/blind-proxy-lib.js"
  "/home/ricos/.config/opencode/opencode.jsonc"
  "/home/ricos/.config/opencode/AGENTS.md"
  "/home/ricos/ricocoder/rule.md"
  "/home/ricos/ricocoder/cloud-agents/cloud_sentinel.py"
  "/home/ricos/ricocoder/scripts/tor-ingress-bridge.js"
)
for f in "${CORE_FILES[@]}"; do
  if [ -f "$f" ]; then
    mkdir -p "$SNAPSHOT_DIR/$(dirname "${f#/}")"
    cp "$f" "$SNAPSHOT_DIR/$(dirname "${f#/}")/"
  fi
done
find /etc/systemd/user/ -name "*.service" 2>/dev/null -exec cp {} "$SNAPSHOT_DIR/etc-systemd/" \;
tar czf "/tmp/eon_brain_$DATE.tar.gz" -C /tmp "eon_brain_$DATE"
echo "SNAPSHOT=/tmp/eon_brain_$DATE.tar.gz"
echo "CID=$(sha256sum "/tmp/eon_brain_$DATE.tar.gz" | cut -d' ' -f1 | head -c 12)"
rm -rf "$SNAPSHOT_DIR"
