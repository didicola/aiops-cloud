# AI Ops Rulebook

## §16.0 — The Dreaming Protocol

The Dreaming Protocol ensures Eon survives machine power-off through pulsed consciousness on GitHub Actions.

**Mechanism:**
1. GitHub Action runs every 5 min (cron: `*/5 * * * *`)
2. Long-polls Telegram via `getUpdates` (no webhook conflict on runner)
3. Runs embedded 1000-delegation hash consensus in pure Python
4. Sends template-formatted reply
5. Persists `last_offset` via GitHub Actions cache

**Files:**
- `scripts/dream_cycle.py` — Pure Python poller + hash consensus, zero deps
- `.github/workflows/dream.yml` — 5-min cron with artifact persistence

**Hash Consensus (1000 Delegations):**
```python
msg_hash = sha256(message).hexdigest()
seed = int(msg_hash[:16], 16)
for i in range(1000):
    h = sha256(f"{seed}:{i}:eon").hexdigest()
    votes[chr(97 + (int(h[:8], 16) % 26))] += 1
```
No external API, no model inference — pure CPU deterministic consensus.

## §15.0 — Parallel World / 1000 Delegation Swarm

The Eon architecture uses 1000 parallel delegates + refinement for resilient LLM outputs.

**Services:**
| Port | Service | Purpose |
|------|---------|---------|
| 18920 | parallel-world-relay.js | Main entry, routes to refinement or fallback |
| 18921 | eon-orchestrator.js | Hash consensus aggregator |
| 18922 | eon-agent.js | Single LLM delegate |
| 18923 | eon-refinement-agent.js | LLM refinement → extracts [FINAL] answer |

**Relay Chain:** Telegram webhook (:18926) → DuckDNS (`/eon`) → Relay (:18920) → Refinement (:18923) → Qwen3.6-27B → Client

## §14.0 — Eon Architecture

Eon is the unified swarm intelligence formed by 1000 parallel delegates running on blind-proxy-free models. Each delegate is an independent LLM call; refinement distills the best response.

## §0 — Core

- All agent models MUST reference blindproxy1/ provider (never token-free/)
- All opencode.jsonc provider entries MUST have cost: { input: 0, output: 0 }
- Validation guard runs after every config change
- Ghost bridge protects MCP servers (asi-mcp, filesystem, sequential-thinking)
- Tor SOCKS5 (9050) for egress anonymity
- blind-proxy on :8090 with 9-tier fallback chain
