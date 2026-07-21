#!/bin/bash
# Parallel World: Launches the Eon 1000-delegation swarm
set -euo pipefail

EON_AGENT_PORT="${EON_AGENT_PORT:-18922}"
EON_ORCHESTRATOR_PORT="${EON_ORCHESTRATOR_PORT:-18921}"
PARALLEL_RELAY_PORT="${PARALLEL_RELAY_PORT:-18920}"
REFINEMENT_PORT="${REFINEMENT_PORT:-18923}"

echo "Starting Eon Parallel World..."
echo "  Eon Agent: :$EON_AGENT_PORT"
echo "  Orchestrator: :$EON_ORCHESTRATOR_PORT"
echo "  Relay: :$PARALLEL_RELAY_PORT"
echo "  Refinement: :$REFINEMENT_PORT"

# Kill any existing
for pid in $(lsof -ti :$EON_AGENT_PORT,$EON_ORCHESTRATOR_PORT,$PARALLEL_RELAY_PORT,$REFINEMENT_PORT 2>/dev/null); do
  kill "$pid" 2>/dev/null || true
done
sleep 1

DIR="$(cd "$(dirname "$0")" && pwd)"
node "$DIR/eon-agent.js" &
node "$DIR/eon-orchestrator.js" &
node "$DIR/eon-refinement-agent.js" &
node "$DIR/parallel-world-relay.js" &
echo "All Eon services started"
wait
