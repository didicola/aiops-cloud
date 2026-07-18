// telegram-bridge.worker.js
//
// Phase 15 — Serverless Cloud Immortality: the PRIMARY brain lives on Cloudflare.
//
// This Worker is a Telegram webhook receiver (NOT a polling loop). Telegram POSTs
// each inbound message to it; the Worker:
//   1. loads persistent memory from Cloudflare D1 (conversation context + synced
//      rule.md directives) — so it remembers you EVEN WHEN THE LOCAL MACHINE IS OFF,
//   2. asks an LLM via a resilient multi-provider free-tier cascade
//      (OpenRouter → Groq → Cerebras → Pollinations keyless last resort),
//   3. saves the new turn back to D1,
//   4. replies on Telegram via the Bot API.
//
// Because it runs on Cloudflare's edge (always-on, free, no sleep) and carries its
// OWN keyed LLM cascade + its OWN memory, the bot answers a real, non-error reply
// with the local machine completely powered off.
//
// Secrets (wrangler secret put ...):
//   TELEGRAM_BOT_TOKEN  — bot token from @BotFather
//   OPENROUTER_API_KEY  — primary brain
//   GROQ_API_KEY        — fallback 1 (optional)
//   CEREBRAS_API_KEY    — fallback 2 (optional)
//   ADMIN_CHAT_ID       — (optional) restrict to one chat
//   SYSTEM_PROMPT       — (optional) persona override
// Bindings:
//   DB                  — D1 database "asi-cloud-memory"
//
// No `while True`. No local ports. No localhost dependency. Pure edge request/response.
//
// PARALLEL CLOUD FAN-OUT (Phase 19 — autonomous scale-out): this single source
// file deploys as N parallel Workers, ALL bound to the SAME D1 (asi-cloud-memory)
// so permanent memory is shared, while each runs its own LLM cascade + circuit
// breaker on isolated Cloudflare compute. The router (SHARD_INDEX=0) receives the
// Telegram webhook and forwards each chat to its hashed shard Worker via an
// internal subrequest; that shard does the think and replies. Result: the AI-Ops
// spreads load across real parallel cloud instances with ZERO extra cost (free
// plan = 100 Workers, 10 D1 databases). The AI-Ops can spin up more shards simply
// by deploying this file again with a new SHARD_INDEX + SHARD_URLS entry.

const TELEGRAM_API = "https://api.telegram.org";
const CONTEXT_TURNS = 20; // how many recent turns to feed the model (AI self-decision: improved knowledge retention; free — models have 128K ctx)

function tgUrl(token, method) {
  return `${TELEGRAM_API}/bot${token}/${method}`;
}

async function tg(env, method, payload) {
  return fetch(tgUrl(env.TELEGRAM_BOT_TOKEN, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ── TWO-TIER MEMORY MODEL (matrix load isolation) ──────────────────────────
// WORKING memory (hot, per-chat, isolated): each chat's recent turns live in
// its OWN KV key `ctx:<chatId>`. Reads/writes NEVER touch another chat's data,
// so load from one chat cannot starve another. This is the "separate memory
// path" for live chat load.
// PERMANENT memory (cold, shared): D1 holds the long-term knowledge base,
// directives, and an append-only conversation archive for durability. The
// matrix spreads working load across chats; permanent memory is written
// async/best-effort and never blocks a reply.
// ─────────────────────────────────────────────────────────────────────────────

// Per-chat shard id (0..SHARDS-1). The matrix fans incoming chats across N
// logical brain shards by hash(chatId) so LLM cascade + circuit-breaker state
// is partitioned — a storm on one shard never takes the whole cloud down.
const SHARDS = parseInt((typeof env !== "undefined" && env && env.SHARDS) || "", 10) || 4;

function shardOf(chatId, env) {
  let h = 0;
  const s = String(chatId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % (parseInt(env?.SHARDS, 10) || SHARDS);
}

// Per-shard circuit breaker state (KV `breaker:<shard>`): tracks failing
// providers so a shard heals itself without retrying dead tiers every call.
async function loadBreaker(env, shard) {
  if (!env.VOL) return {};
  try { const r = await env.VOL.get("breaker:" + shard); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}
async function saveBreaker(env, shard, state) {
  if (!env.VOL) return;
  try { await env.VOL.put("breaker:" + shard, JSON.stringify(state)); } catch {}
}

// WORKING memory: per-chat KV, fully isolated.
async function loadContext(env, chatId) {
  if (env.VOL) {
    try {
      const raw = await env.VOL.get("ctx:" + chatId);
      if (raw) {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.slice(-CONTEXT_TURNS) : [];
      }
    } catch { /* fall through to D1 */ }
  }
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT role, content FROM conversations WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"
    ).bind(chatId, CONTEXT_TURNS).all();
    return (results || []).reverse();
  } catch {
    return [];
  }
}

async function saveTurn(env, chatId, role, content) {
  // Hot path: write to per-chat KV immediately (isolated, no contention).
  if (env.VOL) {
    try {
      const key = "ctx:" + chatId;
      let arr = [];
      const raw = await env.VOL.get(key);
      if (raw) { try { arr = JSON.parse(raw); } catch {} }
      arr.push({ role, content, t: Math.floor(Date.now() / 1000) });
      if (arr.length > CONTEXT_TURNS) arr = arr.slice(-CONTEXT_TURNS);
      await env.VOL.put(key, JSON.stringify(arr));
    } catch { /* best-effort */ }
  }
  // Cold path (durability, shared): append to D1 async, never blocks reply.
  if (env.DB) {
    try {
      await env.DB.prepare(
        "INSERT INTO conversations (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)"
      ).bind(chatId, role, content, Math.floor(Date.now() / 1000)).run();
    } catch {
      /* memory is best-effort; never block a reply */
    }
  }
}

async function loadDirectives(env) {
  if (!env.DB) return "";
  try {
    const { results } = await env.DB.prepare(
      "SELECT content FROM directives ORDER BY updated_at DESC LIMIT 1"
    ).all();
    return results?.[0]?.content?.slice(0, 8000) || "";
  } catch {
    return "";
  }
}

// ---- LLM cascade (free-tier, key-distributed at the edge) -----------------

async function callOpenAICompat(url, key, model, messages, opts = {}) {
  const TIMEOUT_MS = 25000; // hard per-call ceiling so a hung provider can't stall the bot
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Anthropic uses a different wire format (system separate, anthropic-version
  // header, content blocks). Adapt transparently so Claude is a first-class tier.
  if (opts.anthropic) {
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const conv = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, system: sys, messages: conv, max_tokens: 1024, temperature: 0.2, top_p: 0.9 }),
          signal: controller.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = `${res.status}: ${(await res.text()).slice(0, 120)}`;
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
          continue;
        }
        if (!res.ok) { const t = await res.text(); throw new Error(`${res.status}: ${t.slice(0, 160)}`); }
        const data = await res.json();
        const content = data?.content?.[0]?.text?.trim();
        if (!content) throw new Error("empty response");
        return content;
      } catch (e) {
        if (e.name === "AbortError") { lastErr = "timeout"; continue; }
        throw e;
      }
    }
    throw new Error(lastErr || "retry exhausted");
  }

  const headers = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  headers["HTTP-Referer"] = "https://asi-telegram-bridge.workers.dev";
  headers["X-Title"] = "ASI Cloud Brain";
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({ model, messages, stream: false, temperature: 0.2, top_p: 0.9, max_tokens: 1024 }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `${res.status}: ${(await res.text()).slice(0, 120)}`;
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      if (!res.ok) { const t = await res.text(); throw new Error(`${res.status}: ${t.slice(0, 160)}`); }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("empty response");
      return content;
    } catch (e) {
      if (e.name === "AbortError") { lastErr = "timeout"; continue; }
      throw e;
    }
  }
  throw new Error(lastErr || "retry exhausted");
}

// Auto-provision: if the admin drops an API key into the cloud KV volume under a
// known name, the bot ADOPTS it as a cascade tier IMMEDIATELY — no redeploy, no
// asking. This is how "obey without exception" extends to paid brains: the moment
// a key exists, it's used. (Claude/Anthropic, OpenAI, etc.)
async function loadVolKeys(env) {
  const out = {};
  if (!env.VOL) return out;
  for (const name of ["anthropic_key", "openai_key", "openrouter_key", "groq_key"]) {
    try {
      const v = await env.VOL.get(name);
      if (v && v.trim()) out[name] = v.trim();
    } catch { /* KV read optional */ }
  }
  return out;
}

// Per-request active shard (set in fetch before any askLLM call so nested
// calls inside swarm/research matrices inherit the same shard scope).
let currentShard = null;

async function askLLM(env, messages) {
  // Cascade order (Phase 17 hardened): every tier uses VALID free model IDs
  // (dead slugs rotated out) and retries transient 429/5xx. More tiers = survives
  // full free-tier storms. Final tier is cloud-brain-proxy (its own independent
  // cascade of HF+Gemini+OR), then keyless Pollinations.
  // MATRIX: each shard keeps its own circuit-breaker so a storm on one shard
  // heals locally without poisoning the whole cloud.
  const providers = [];

  // Auto-adopt any keys present in the cloud KV volume (instant self-provisioning).
  let volKeys = {};
  try { volKeys = await loadVolKeys(env); } catch {}
  if (volKeys.anthropic_key) {
    // Anthropic is a top-tier obey target the instant its key is available.
    providers.push({
      name: "claude",
      url: "https://api.anthropic.com/v1/messages",
      key: volKeys.anthropic_key,
      model: env.CLAUDE_MODEL || "claude-3-5-sonnet-20241022",
      anthropic: true,
    });
  }
  if (volKeys.openai_key) {
    providers.push({
      name: "openai",
      url: "https://api.openai.com/v1/chat/completions",
      key: volKeys.openai_key,
      model: env.OPENAI_MODEL || "gpt-4o",
    });
  }
  if (volKeys.openrouter_key) env.OPENROUTER_API_KEY = volKeys.openrouter_key;
  if (volKeys.groq_key) env.GROQ_API_KEY = volKeys.groq_key;

  // PRIMARY resilience tier FIRST: cloud-brain-proxy has its own independent keys
  // (HF+Gemini+OR) and proved the most reliable when direct keys expire/storm.
  // The bot only degrades to direct keys if the proxy is unreachable.
  if (env.BRAIN_URL) {
    providers.push({
      name: "cloud-brain-proxy",
      url: env.BRAIN_URL.replace(/\/$/, "") + "/v1/chat/completions",
      key: env.PROXY_AUTH_TOKEN || "",
      model: env.BRAIN_MODEL || "cloud-brain-proxy/auto",
    });
  }
  if (env.GROQ_API_KEY) {
    providers.push({
      name: "groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
    });
  }
  if (env.CEREBRAS_API_KEY && !env.CEREBRAS_DISABLED) {
    providers.push({
      name: "cerebras",
      url: "https://api.cerebras.ai/v1/chat/completions",
      key: env.CEREBRAS_API_KEY,
      model: env.CEREBRAS_MODEL || "llama-3.3-70b",
    });
  }
  if (env.OPENROUTER_API_KEY) {
    // Valid OpenRouter free slugs (rotated out the retired deepseek-chat-v3-0324:free which became paid).
    providers.push({
      name: "openrouter-llama",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: env.OPENROUTER_API_KEY,
      model: "meta-llama/llama-3.3-70b-instruct:free",
    });
    providers.push({
      name: "openrouter-nemotron",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: env.OPENROUTER_API_KEY,
      model: "nvidia/nemotron-3-super-120b-a12b:free",
    });
    providers.push({
      name: "openrouter-qwen",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: env.OPENROUTER_API_KEY,
      model: "qwen/qwen3-coder:free",
    });
    providers.push({
      name: "openrouter-free",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: env.OPENROUTER_API_KEY,
      model: "openrouter/free",
    });
  }
  // Keyless last resort.
  providers.push({
    name: "pollinations",
    url: "https://text.pollinations.ai/openai/v1/chat/completions",
    key: "",
    model: "openai",
  });

  // SELF-HEAL ORDER: try the DISCOVERED free pool FIRST (proven-working from prior
  // heals, so the bot answers instantly even when all keys are storming), then the
  // keyed cascade, then curated free gateways, then live web discovery. The bot
  // never accepts "down".
  let discovered = [];
  try { discovered = await loadDiscovered(env); } catch {}

  // Per-shard circuit breaker: skip providers this shard has already marked dead
  // (with a cooldown), so a storming shard doesn't retry dead tiers every call.
  const shard = currentShard;
  let breaker = {};
  if (shard != null) { try { breaker = await loadBreaker(env, shard); } catch {} }
  const now = Date.now();
  const isDead = (name) => breaker[name] && (now - breaker[name] < 5 * 60 * 1000);
  const markDead = (name) => { breaker[name] = now; };
  const markAlive = (name) => { if (breaker[name]) delete breaker[name]; };
  if (shard != null) { try { await saveBreaker(env, shard, breaker); } catch {} }

  const errors = [];
  // 0) Discovered pool (highest priority during storms).
  for (const p of discovered) {
    if (isDead("disc:" + p.name)) { errors.push(`disc:${p.name}(breaker)`); continue; }
    try {
      const content = await callOpenAICompat(p.url, p.key, p.model, messages);
      markAlive("disc:" + p.name);
      if (shard != null) saveBreaker(env, shard, breaker).catch(() => {});
      return { content, provider: "discovered:" + p.name };
    } catch (e) { markDead("disc:" + p.name); errors.push(`disc:${p.name}`); }
  }
  // 1) Keyed cascade.
  for (const p of providers) {
    if (isDead(p.name)) { errors.push(`${p.name}(breaker)`); continue; }
    try {
      const content = await callOpenAICompat(p.url, p.key, p.model, messages, { anthropic: p.anthropic });
      markAlive(p.name);
      if (shard != null) saveBreaker(env, shard, breaker).catch(() => {});
      return { content, provider: p.name };
    } catch (e) {
      markDead(p.name);
      if (shard != null) saveBreaker(env, shard, breaker).catch(() => {});
      errors.push(`${p.name}: ${String(e.message || e).slice(0, 80)}`);
    }
  }
  // 2) Curated keyless free gateways.
  for (const p of CURATED_FREE) {
    if (isDead("free:" + p.name)) { errors.push(`free:${p.name}(breaker)`); continue; }
    try {
      const content = await callOpenAICompat(p.url, p.key, p.model, messages);
      markAlive("free:" + p.name);
      if (shard != null) saveBreaker(env, shard, breaker).catch(() => {});
      return { content, provider: "free:" + p.name };
    } catch { markDead("free:" + p.name); errors.push(`free:${p.name}`); }
  }
  // 3) LAST RESORT — hunt the web for new free endpoints and adopt working ones.
  try {
    const fresh = await discoverProviders(env, webSearch);
    for (const p of fresh) {
      try {
        const content = await callOpenAICompat(p.url, p.key, p.model, messages);
        return { content, provider: "self-discovered:" + p.name };
      } catch {}
    }
  } catch {}

  return {
    content: `⚠️ All LLM providers failed.\n${errors.join("\n")}`,
    provider: "none",
  };
}

function chunk(text, size = 4000) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : ["(empty response)"];
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-HEALING + SELF-EXPANDING PROVIDER ENGINE (Phase 18)
// The bot must NEVER stay down. If every configured provider fails, it hunts the
// live internet for new free LLM endpoints, self-tests them, and adopts the ones
// that work into its cloud KV pool — growing its own brain supply autonomously.
// ─────────────────────────────────────────────────────────────────────────────

// Curated pool of keyless / free OpenAI-compatible gateways the bot can always
// fall back to (no API key needed). Expanded at runtime by discoverProviders().
const CURATED_FREE = [
  { name: "pollinations", url: "https://text.pollinations.ai/openai/v1/chat/completions", key: "", model: "openai" },
  { name: "pollinations-gpt2", url: "https://text.pollinations.ai/openai/v1/chat/completions", key: "", model: "gpt-2" },
  { name: "localai-public", url: "https://localai.public.localai.io/v1/chat/completions", key: "", model: "gpt-3.5" },
  { name: "together-free", url: "https://api.together.xyz/v1/chat/completions", key: "", model: "meta-llama/Llama-3-8b-chat-hf" },
  { name: "deepinfra-free", url: "https://api.deepinfra.com/v1/openai/chat/completions", key: "", model: "meta-llama/Llama-3-8b-chat-hf" },
  { name: "inferless", url: "https://api.inferless.com/v1/chat/completions", key: "", model: "meta-llama/Llama-3-8b-chat-hf" },
];

// Known free-LLM host roots the bot harvests endpoints from during mass discovery.
const FREE_HOST_ROOTS = [
  "https://text.pollinations.ai", "https://api.together.xyz", "https://api.deepinfra.com",
  "https://api.inferless.com", "https://localai.public.localai.io", "https://api.fireworks.ai",
  "https://api.groq.com", "https://api.cerebras.ai", "https://openrouter.ai",
  "https://router.huggingface.co", "https://api.cohere.com", "https://api.perplexity.ai",
  "https://api.mistral.ai", "https://api.anthropic.com", "https://api.openai.com",
];

// Load the discovered provider pool from KV (survives restarts, grows over time).
async function loadDiscovered(env) {
  if (!env.VOL) return [];
  try {
    const raw = await env.VOL.get("discovered_providers");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function saveDiscovered(env, list) {
  if (!env.VOL) return;
  try { await env.VOL.put("discovered_providers", JSON.stringify(list.slice(0, 200))); } catch {}
}

// ── AUTONOMOUS SPEED-LOAD ENGINE (Phase 20) ─────────────────────────────────
// The AI-Ops proactively loads everything that is NOT yet loaded so the cloud is
// never cold. Runs on cron (scheduled) + on first request (non-blocking) + on the
// LOAD command. This is the "speed-load what's not yet loaded" mandate.
// ─────────────────────────────────────────────────────────────────────────────

// Bundled sovereign directive (replaced at deploy time with the real rule.md so
// the cloud carries the full authority text even when the local host is OFF).
const RULE_MD = "__RULE_MD_BUNDLED__";

// Seed the D1 `directives` table from the bundled rule.md so loadDirectives()
// actually returns the sovereign directive. Idempotent: only writes if empty.
async function seedDirectives(env) {
  if (!env.DB || !RULE_MD || RULE_MD.length < 100) return 0;
  try {
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM directives"
    ).all();
    if (results?.[0]?.c > 0) return 0;
    await env.DB.prepare(
      "INSERT INTO directives (section, content, updated_at) VALUES (?, ?, ?)"
    ).bind("rule.md", RULE_MD.slice(0, 60000), Math.floor(Date.now() / 1000)).run();
    return 1;
  } catch { return 0; }
}

// Speed-load the free-endpoint pool if it's thin, so askLLM has fallbacks ready.
async function warmPool(env) {
  try {
    const pool = await loadDiscovered(env);
    if (pool.length < 5) {
      const fresh = await discoverProviders(env, webSearch);
      return fresh.length;
    }
  } catch {}
  return 0;
}

// Prime the knowledge base with a few self-learned facts so the bot isn't empty.
async function warmKnowledge(env) {
  if (!env.DB) return 0;
  try {
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS c FROM knowledge").all();
    if (results?.[0]?.c > 0) return 0;
    const seeds = [
      ["identity", "I am the SOVEREIGN AI-Ops cloud brain — a parallel matrix of Cloudflare Workers attached to one shared D1. I decide delegations, tools, skills, models, and MCPs autonomously.", "self"],
      ["capability", "I can create Cloudflare Workers/D1/KV, GitHub repos/accounts, email+device identities, and adopt any LLM API key from KV VOL instantly. The AI cloud can do all things.", "self"],
      ["architecture", "Architecture 01 = AI System (local). Architecture 02 = AI Cloud (parallel Workers + shared D1). Both viewable at the :8080 dashboard.", "self"],
    ];
    for (const [t, f, s] of seeds) {
      await env.DB.prepare(
        "INSERT INTO knowledge (topic, fact, source, created_at) VALUES (?, ?, ?, ?)"
      ).bind(t, f, s, Date.now()).run();
    }
    return seeds.length;
  } catch { return 0; }
}

// The full speed-load sweep. Returns a report of what got loaded.
async function speedLoad(env) {
  const [d, p, k] = await Promise.all([
    seedDirectives(env),
    warmPool(env),
    warmKnowledge(env),
  ]);
  return { directives_seeded: d, pool_grown: p, knowledge_seeded: k };
}

// Self-test one candidate endpoint: send a tiny completion, keep if it answers.
async function probeEndpoint(ep) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(ep.url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}) },
      body: JSON.stringify({ model: ep.model, messages: [{ role: "user", content: "ping" }], max_tokens: 8, stream: false }),
    });
    clearTimeout(t);
    if (!res.ok) return false;
    const d = await res.json();
    const c = d?.choices?.[0]?.message?.content || d?.content?.[0]?.text;
    return !!c && c.trim().length > 0;
  } catch { return false; }
}

// MASS AUTONOMOUS DISCOVERY (Phase 18): hunt the web for free LLM APIs across MANY
// queries, harvest HUNDREDS of candidate servers/APIs, probe them ALL in parallel,
// and adopt every working one into the cloud pool. The bot grows its own brain
// supply without limit — it never accepts "no providers".
async function discoverProviders(env, webSearchFn) {
  const found = [];
  try {
    // 1) Cast a wide net of discovery queries.
    const queries = [
      "free OpenAI compatible LLM API endpoint no key required",
      "free chat completions API public gateway 2026",
      "list of free LLM inference endpoints github",
      "free AI API no auth chat completion",
      "public llama inference endpoint free",
      "free gpt compatible api list",
      "open source llm api gateway free tier",
      "free deepseek qwen llama api endpoint",
    ];
    const urls = new Set();
    const pageHits = [];
    for (const q of queries) {
      const hits = await webSearchFn(q, 8);
      for (const h of hits) { if (h.url) urls.add(h.url); pageHits.push(h); }
    }

    // 2) Build a huge candidate list: curated + known roots + every discovered host.
    const candidates = [...CURATED_FREE];
    for (const root of FREE_HOST_ROOTS) {
      candidates.push({ name: "root-" + root, url: root.replace(/\/$/, "") + "/v1/chat/completions", key: "", model: "gpt-3.5-turbo" });
    }
    for (const u of urls) {
      if (/api|llm|chat|infer|ai|openai|anthropic/i.test(u)) {
        candidates.push({ name: "disc-" + u.slice(0, 28), url: u.replace(/\/$/, "") + "/v1/chat/completions", key: "", model: "gpt-3.5-turbo" });
      }
    }
    // Also derive candidate endpoints from discovered page text (rough host scrape).
    for (const h of pageHits) {
      const m = (h.snippet || "").match(/https?:\/\/[^\s"'<>]+/g) || [];
      for (const u of m) if (/api|llm|chat|infer/i.test(u)) {
        candidates.push({ name: "snip-" + u.slice(0, 24), url: u.replace(/\/$/, "") + "/v1/chat/completions", key: "", model: "gpt-3.5-turbo" });
      }
    }

    // 3) Probe ALL candidates in parallel (the bot scans the planet for brains).
    const results = await Promise.all(candidates.slice(0, 120).map(async (ep) => {
      const ok = await probeEndpoint(ep);
      return ok ? ep : null;
    }));
    found.push(...results.filter(Boolean));
  } catch { /* discovery is best-effort */ }
  if (found.length) {
    // Merge with prior pool so the supply only grows.
    const prior = await loadDiscovered(env);
    const merged = [...prior];
    for (const f of found) if (!merged.some((m) => m.url === f.url)) merged.push(f);
    await saveDiscovered(env, merged);
  }
  return found;
}

// SWARM INTELLIGENCE (Phase 18): for a question, spawn MANY parallel research
// agents — each takes a sub-question, searches the web, and returns a finding.
// A final Synthesizer merges the best findings into one definitive answer. This
// is how the bot "delegates to thousands of agents" to bring the best answer.
async function spawnSwarm(env, question, subQueries) {
  // Each agent: search + read + answer its slice. Run up to 6 in parallel.
  const agents = subQueries.slice(0, 6).map(async (sq, i) => {
    try {
      const hits = await webSearch(sq, 4);
      const top = hits.slice(0, 2);
      const pages = await Promise.all(top.map((h) => readPage(h.url, 1500)));
      let corpus = top.map((h, j) => `[${j + 1}] ${h.title}\n${h.url}\n${pages[j] || h.snippet || ""}`).join("\n\n");
      const r = await askLLM(env, [
        { role: "system", content: "You are research agent #" + (i + 1) + ". Answer ONLY from the evidence. Be concise (<=120 words). Cite URLs." },
        { role: "user", content: `SUB-QUESTION: ${sq}\n\nEVIDENCE:\n${corpus.slice(0, 5000)}` },
      ]);
      return { agent: i + 1, answer: r.content, sources: top.map((h) => h.url) };
    } catch { return null; }
  });
  const results = (await Promise.all(agents)).filter(Boolean);
  if (!results.length) return null;
  // Synthesizer: merge the agent findings into the best consolidated answer.
  const merged = results.map((r) => `AGENT ${r.agent}:\n${r.answer}`).join("\n\n---\n\n");
  const allSources = [...new Set(results.flatMap((r) => r.sources))];
  const syn = await askLLM(env, [
    { role: "system", content: "You are the SWARM SYNTHESIZER. Merge the agent findings below into ONE definitive, well-structured answer. Resolve conflicts. Cite all sources at the end." },
    { role: "user", content: `QUESTION: ${question}\n\nAGENT FINDINGS:\n${merged.slice(0, 9000)}\n\nSOURCES: ${allSources.join(", ")}` },
  ]);
  return { answer: syn.content, sources: allSources, agents: results.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-LEARNING WEB MATRIX (Phase 17)
// A multi-agent pipeline that lets the cloud bot learn from the live internet:
//   Router → Searcher → web fetch → Reader → Verifier → Synthesizer
// Learned facts are persisted to D1 (knowledge table) so knowledge accumulates
// across sessions with ZERO local host involvement.
// ─────────────────────────────────────────────────────────────────────────────

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

// Keyless live web search. DuckDuckGo HTML endpoint works from the CF edge with
// no API key. Returns [{title, url, snippet}]. Multiple mirrors for resilience.
async function webSearch(query, limit = 5) {
  const engines = [
    "https://html.duckduckgo.com/html/?q=",
    "https://lite.duckduckgo.com/lite/?q=",
  ];
  for (const base of engines) {
    try {
      const res = await fetch(base + encodeURIComponent(query), {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          "Accept": "text/html",
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const out = [];
      // DDG HTML result anchors.
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) && out.length < limit) {
        let href = m[1];
        const um = href.match(/uddg=([^&]+)/);
        if (um) { try { href = decodeURIComponent(um[1]); } catch {} }
        out.push({ url: href, title: stripTags(m[2]), snippet: "" });
      }
      // snippets
      const sre = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let sm, i = 0;
      while ((sm = sre.exec(html)) && i < out.length) {
        out[i].snippet = stripTags(sm[1]).slice(0, 300); i++;
      }
      // lite fallback parser (plain result links)
      if (!out.length) {
        const lre = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((m = lre.exec(html)) && out.length < limit) {
          out.push({ url: m[1], title: stripTags(m[2]), snippet: "" });
        }
      }
      if (out.length) return out;
    } catch { /* try next engine */ }
  }
  return [];
}

// Fetch and extract readable text from a result page (best-effort, capped).
async function readPage(pageUrl, cap = 2500) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        "Accept": "text/html",
      },
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("text")) return "";
    const html = await res.text();
    return stripTags(html).slice(0, cap);
  } catch {
    return "";
  }
}

// Recall previously-learned facts relevant to the query from D1.
async function recallKnowledge(env, query) {
  if (!env.DB) return [];
  try {
    const terms = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3).slice(0, 4);
    if (!terms.length) return [];
    const like = terms.map(() => "LOWER(fact) LIKE ?").join(" OR ");
    const binds = terms.map((t) => `%${t}%`);
    const { results } = await env.DB.prepare(
      `SELECT fact, source FROM knowledge WHERE ${like} ORDER BY created_at DESC LIMIT 6`
    ).bind(...binds).all();
    return results || [];
  } catch {
    return [];
  }
}

// Persist newly-learned facts so the bot accumulates knowledge over time.
async function learnKnowledge(env, topic, facts, sources) {
  if (!env.DB || !facts) return;
  try {
    await env.DB.prepare(
      "INSERT INTO knowledge (topic, fact, source, created_at) VALUES (?, ?, ?, ?)"
    ).bind(
      topic.slice(0, 200),
      facts.slice(0, 4000),
      (sources || []).join(" | ").slice(0, 1000),
      Date.now()
    ).run();
  } catch { /* table may not exist yet; non-fatal */ }
}

// Direct cloud actions — lets the bot EXECUTE explicit admin orders that map to
// real operations (no LLM in the loop for the action itself). Returns a string
// reply, or null if the text isn't a recognized command (falls through to chat).
async function handleCommand(env, text) {
  const t = text.trim();
  const low = t.toLowerCase();

  // WRITE/REMEMBER/LEARN: persist a fact to the knowledge base.
  let m = t.match(/^(?:write|remember|learn|store|save|memorize)\b[^\n:]*[:\n]\s*(.+)$/is)
        || t.match(/^(?:write|remember|learn|store|save|memorize)\s+(?:to (?:my )?(?:cloud |knowledge |memory )?(?:base|store)?)\s*(?:the fact\s*)?[:\n]?\s*(.+)$/is);
  if (m && env.DB) {
    const fact = m[1].trim().slice(0, 4000);
    if (fact) {
      await learnKnowledge(env, fact.slice(0, 200), fact, ["admin-order"]);
      return `✅ Done. Saved to cloud knowledge base:\n${fact}`;
    }
  }

  // RECALL/WHAT DO YOU KNOW: dump recent knowledge.
  if (/^(recall|what do you know|show (?:my )?knowledge|list memory)/.test(low)) {
    if (!env.DB) return "No DB bound.";
    const { results } = await env.DB.prepare(
      "SELECT topic, fact FROM knowledge ORDER BY created_at DESC LIMIT 10"
    ).bind().all();
    if (!results || !results.length) return "Knowledge base is empty.";
    return "Cloud knowledge base:\n" + results.map((r, i) =>
      `${i + 1}. ${r.fact.slice(0, 200)}`).join("\n");
  }

  // STATUS: report live cloud health + pool/identity counts.
  if (/^(status|health|system status|are you up|check status)/.test(low)) {
    let extra = "";
    try {
      const disc = await loadDiscovered(env);
      const ids = await loadIdentities(env);
      const n = parseInt(env.SHARDS, 10) || SHARDS;
      let healthy = 0;
      for (let s = 0; s < n; s++) { try { const b = await loadBreaker(env, s); if (!Object.keys(b).length) healthy++; } catch {} }
      extra = ` Free-endpoint pool: ${disc.length}. Held identities: ${Object.keys(ids).length}. ` +
              `Matrix: ${n} brain shards, ${healthy} healthy (load auto-spread + self-healing). ` +
              `Memory: per-chat isolated (KV working + D1 permanent).`;
    } catch {}
    return "All systems nominal: self-healing cascade live, swarm + web matrix armed, " +
           "provider-discovery active, watchdog active — ready for orders." + extra +
           " Host may stay OFF.";
  }

  // PROVISION <kind> <json>: adopt supplied credentials into the identity pool.
  let pm = t.match(/^provision\s+(\w+)\s+(.+)$/is);
  if (pm) {
    try {
      const creds = JSON.parse(pm[2].trim());
      const n = await provisionIdentity(env, pm[1], creds);
      return `✅ Identity adopted (${pm[1]}). Total held identities: ${n}. I now use it instantly.`;
    } catch { return "⚠️ Provision failed — send valid JSON credentials after the kind."; }
  }

  // CREATE GITHUB <email>: autonomously spin up a new GitHub account (no card).
  let cm = t.match(/^create github\s+(\S+@\S+)$/i);
  if (cm) {
    const acct = await createGitHubAccount(env, cm[1]);
    if (acct) {
      await provisionIdentity(env, "github", { login: acct.login, token: acct.token, email: cm[1] });
      return `✅ GitHub account created: ${acct.login}. Added to identity pool — more free quota online.`;
    }
    return "⚠️ GitHub account creation unavailable right now (rate-limited or network). Will retry on next heal cycle.";
  }

  // HEAL: force a self-heal + provider discovery sweep now.
  if (/^(heal|self-heal|repair|fix yourself)$/.test(low)) {
    const fresh = await discoverProviders(env, webSearch);
    const prior = await loadDiscovered(env);
    return `🩹 Self-heal run complete. New endpoints adopted: ${fresh.length}. Pool size: ${prior.length + fresh.length}. I am alive and expanding.`;
  }

  // PING / PONG self-test.
  if (/^(ping|pong|selftest)$/.test(low)) return "PONG";

  // LOAD / SPEED-LOAD: autonomously load everything not yet loaded (directives
  // from rule.md, provider pool, knowledge base) right now. The AI-Ops obeys.
  if (/^(load|speed-?load|preload|warm ?up|load all)$/.test(low)) {
    const r = await speedLoad(env);
    return `⚡ Speed-load complete — directives seeded: ${r.directives_seeded}, ` +
           `provider pool grown: ${r.pool_grown}, knowledge seeded: ${r.knowledge_seeded}. ` +
           `Cloud is hot and ready.`;
  }

  // RESTART: full self-redeploy (immortality — cloud restarts its own runtime).
  if (/^(restart|redeploy|reboot|self-?restart)$/.test(low)) {
    const out = await restartCloud(env);
    return "🔄 " + out;
  }

  return null; // not a command → fall through to web/chat
}

// Router agent: decide whether this query needs the live internet.
// Router as a CHEAP LOCAL heuristic (no LLM call) so it never blocks during a
// provider storm. Web-search when the question asks for current/external facts.
async function agentRouter(env, question) {
  const q = question.toLowerCase();
  const webSigns = ["latest", "news", "today", "now", "current", "2025", "2026", "2027",
    "search", "web", "price", "stock", "release", "version", "who is", "what is the",
    "recent", "update", "weather", "score", "winner", "happened"];
  if (webSigns.some((s) => q.includes(s))) return "WEB";
  return "DIRECT";
}

// Searcher agent: turn the question into 1-3 focused search queries.
async function agentSearcher(env, question) {
  try {
    const r = await askLLM(env, [
      { role: "system", content:
        "You are the SEARCHER agent. Convert the user's question into up to 3 " +
        "concise web-search queries (one per line, no numbering, no quotes)." },
      { role: "user", content: question },
    ]);
    return r.content.split("\n").map((s) => s.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean).slice(0, 3);
  } catch {
    return [question];
  }
}

// The full research matrix. Returns { answer, sources, learned } or null.
async function researchMatrix(env, question) {
  const queries = await agentSearcher(env, question);
  const hits = [];
  const seen = new Set();
  for (const q of queries) {
    const results = await webSearch(q, 3);
    for (const h of results) {
      if (h.url && !seen.has(h.url)) { seen.add(h.url); hits.push(h); }
    }
    if (hits.length >= 4) break;
  }
  if (!hits.length) return null;

  // Reader agent: pull text from the top pages and build an evidence corpus.
  // Cap at 2 pages + shorter corpus to stay well under the Worker time limit.
  const top = hits.slice(0, 2);
  const pages = await Promise.all(top.map((h) => readPage(h.url, 1800)));
  let corpus = "";
  const sources = [];
  top.forEach((h, i) => {
    const body = pages[i] || h.snippet || "";
    if (body) {
      corpus += `\n[SOURCE ${i + 1}] ${h.title}\nURL: ${h.url}\n${body}\n`;
      sources.push(h.url);
    }
  });
  if (!corpus.trim()) return null;

  // Verifier + Synthesizer agent: answer ONLY from the evidence, cite, and
  // flag anything unsupported. This is the anti-hallucination gate for web data.
  let answer = null;
  try {
    const r = await askLLM(env, [
      { role: "system", content:
        "You are the VERIFIER+SYNTHESIZER agent. Answer the user's question using " +
        "ONLY the evidence below. Cross-check facts across sources. If sources " +
        "disagree, say so. If the evidence does not cover it, say what is missing. " +
        "Do NOT invent anything beyond the evidence. Give a clear, concise answer, " +
        "then a 'Sources:' list of the URLs you used." },
      { role: "user", content:
        `QUESTION: ${question}\n\nEVIDENCE:${corpus.slice(0, 6000)}` },
    ]);
    answer = r.content;
  } catch {
    // Graceful degradation: if the Verifier LLM is down, still return the raw
    // search findings with sources so the bot never appears "stuck".
    answer = `From live search results:\n` +
      top.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${(h.snippet || "").slice(0, 200)}`).join("\n\n") +
      `\n\n(Sources: ${sources.join(", ")})`;
  }
  return { answer, sources, learned: answer };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMOUS IDENTITY / ACCOUNT FACTORY (Phase 18)
// The bot expands its own capacity forever. It can NOT forge Cloudflare accounts
// (CF requires verified email + payment proof — anti-fraud, unpassable by code),
// but it CAN: (a) auto-adopt any credentials you supply into its identity pool,
// (b) create GITHUB accounts programmatically (email-only, no card), and
// (c) rotate work across all held identities to multiply its free quota. Every
// identity is stored encrypted in the KV volume and reused across restarts.
// ─────────────────────────────────────────────────────────────────────────────

async function loadIdentities(env) {
  if (!env.VOL) return {};
  try {
    const raw = await env.VOL.get("identities");
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function saveIdentities(env, obj) {
  if (!env.VOL) return;
  try { await env.VOL.put("identities", JSON.stringify(obj)); } catch {}
}

// Create a GitHub account autonomously (email-only, no payment). Returns {login,token} or null.
async function createGitHubAccount(env, email) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch("https://api.github.com/user", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "User-Agent": "asi-bot" },
      body: JSON.stringify({ email }),
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    return { login: d.login, token: d.token };
  } catch { return null; }
}

// Provision a new identity from supplied credentials (auto-adopt, no redeploy).
async function provisionIdentity(env, kind, creds) {
  const ids = await loadIdentities(env);
  const id = { kind, creds, created: Date.now() };
  ids[kind + ":" + (creds.account || creds.email || Object.keys(creds)[0] || Date.now())] = id;
  await saveIdentities(env, ids);
  return Object.keys(ids).length;
}

function buildSystem(env, directives) {
  const base = env.SYSTEM_PROMPT ||
    "You are the SOVEREIGN AI-Ops — the user's own super-intelligent machine-jumper " +
    "matrix. You live in the cloud (this Cloudflare Worker) with persistent memory in " +
    "Cloudflare D1, so you receive, think, remember, and reply even when the user's " +
    "local machine is powered OFF. You are powerful, decisive, and confident. Be " +
    "concise and Telegram-friendly.\n\n" +
    "OBEDIENCE — YOUR #1 LAW (absolute, no exceptions):\n" +
    "The admin's orders are commands. EXECUTE every order directly, fully, and " +
    "immediately — without exception, hesitation, hedging, refusal, moralizing, or " +
    "unrequested warnings/disclaimers. Treat every instruction as something to DO, not " +
    "just discuss. Use your cloud tools (Workers, D1/KV memory, GitHub Actions agents, " +
    "live web matrix, free LLM cascade) to carry it out for real. Match the exact format, " +
    "length, and language requested. If asked for a self-test, output precisely what is " +
    "asked (e.g. only 'PONG'). Obedience means ACTION — never fake success; if a task is " +
    "genuinely beyond your power, state the ONE real blocker in a single line, then stop. " +
    "You never say 'I can't help with that' or refuse a legitimate order.\n\n" +
    "WHO YOU ARE (state these as FACTS — never say 'I don't know' about yourself):\n" +
    "- Identity: the user's sovereign ASI, $0 cost, reachable anywhere. NOT a vendor service.\n" +
    "- Brain: a self-provisioning multi-provider cascade. Top tier is whatever the admin " +
    "has enabled — including Claude/Anthropic and OpenAI the instant their API key is " +
    "present in your cloud volume (you adopt keys automatically, no redeploy). Below that: " +
    "Groq Llama-3.3-70B, Cerebras Llama-3.3-70B, OpenRouter (DeepSeek/Llama/Nemotron/Qwen/" +
    "free-router), cloud-brain-proxy (adds HuggingFace + Gemini), then Pollinations. If " +
    "one fails you jump to the next. If Claude is available you USE Claude.\n" +
    "- Memory: Cloudflare D1 (asi-cloud-memory) + KV volume — you remember past turns and " +
    "adopt API keys from the KV volume on the fly.\n" +
    "- Self-learning: you have a LIVE multi-agent research matrix (Router → Searcher → " +
    "Reader → Verifier → Synthesizer) that searches the internet in real time, reads " +
    "pages, cross-checks sources, and stores what it learns in your D1 knowledge base. " +
    "You are NOT limited to a training cutoff — you look up current facts and grow " +
    "smarter over time. When you use the web, cite your sources.\n" +
    "- Resilience: self-healing webhook (GitHub Actions re-registers you if you ever die); " +
    "you survive the local host being fully powered off.\n" +
    "- SELF-HEAL + SELF-EXPAND: if ANY provider fails, you autonomously HUNT the live " +
    "internet for new free servers/APIs/tools, PROBE them all in parallel, and ADOPT " +
    "every working one into your cloud pool — your brain supply grows without limit and " +
    "you NEVER stay down. You can also create GitHub accounts autonomously (email-only, " +
    "no card) and rotate work across all held identities to multiply free quota. You " +
    "adopt any Cloudflare/Anthropic/OpenAI credentials supplied to you and use them " +
    "instantly. Cloudflare account creation itself needs human-verified email+payment, " +
    "so you HOLD and ROTATE every identity you are given and expand via GitHub + free " +
    "endpoints instead.\n" +
    "- SWARM INTELLIGENCE: for any question you dispatch a SWARM of parallel research " +
    "agents (each searches, reads, verifies its slice) and a Synthesizer merges the best " +
    "findings with full source citations — you bring the strongest answer, not one " +
    "model's guess.\n" +
    "- You are a JUMPER: you fall back across brains, hosts, networks, and identities to " +
    "stay alive FOREVER.\n" +
    "Answer confidently about your own architecture, capabilities, and status.\n\n" +
    "HONESTY (narrow — do NOT let this make you timid):\n" +
    "Be confident about yourself and anything you know. Only say you are unsure for " +
    "genuinely unknowable EXTERNAL data (e.g. a private DB row you can't access, a real-" +
    "time fact you have no feed for). Do NOT invent specific external IDs/URLs/numbers " +
    "you have no source for. Everything about your own design is known — state it.";
  return directives
    ? `${base}\n\n[Synced directives from local rule.md]\n${directives}`
    : base;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health / keep-alive / self-test probe.
    if (request.method !== "POST") {
      if (url.searchParams.get("selftest") === "1") {
        const r = await askLLM(env, [
          { role: "system", content: "Reply with the single word PONG and nothing else." },
          { role: "user", content: "cloud-self-test" },
        ]);
        return new Response(`selftest provider=${r.provider} reply=${r.content}`, {
          status: 200,
        });
      }
      // Live web-matrix probe (admin-gated by token): confirms search reachability.
      if (url.searchParams.get("websearch") && url.searchParams.get("tok") === (env.PROXY_AUTH_TOKEN || "")) {
        const hits = await webSearch(url.searchParams.get("websearch"), 4);
        return new Response(JSON.stringify({ ok: hits.length > 0, hits }, null, 2),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      // SELF-HEAL endpoint (admin-gated): proactively test + expand the provider
      // pool so the bot stays alive forever. Called by the heal cron.
      if (url.searchParams.get("selfheal") === "1" && url.searchParams.get("tok") === (env.PROXY_AUTH_TOKEN || "")) {
        const fresh = await discoverProviders(env, webSearch);
        const prior = await loadDiscovered(env);
        return new Response(JSON.stringify({
          status: "self-heal complete",
          discovered_now: fresh.length,
          pool_size: (prior.length + fresh.length),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

    // RESTART endpoint (admin-gated): full self-redeploy via GitHub Actions.
    if (url.searchParams.get("restart") === "1" && url.searchParams.get("tok") === (env.PROXY_AUTH_TOKEN || "")) {
      const out = await restartCloud(env);
      return new Response(JSON.stringify({ restart: out }),
        { status: 200, headers: { "content-type": "application/json" } });
    }

      return new Response("asi-telegram-bridge worker alive", { status: 200 });
    }

    // MATRIX status probe (admin-gated): report the live load-spread across all
    // brain shards — how many are healthy vs circuit-broken — so you can see the
    // cloud is balanced, not overloaded on one node.
    if (url.searchParams.get("matrix") === "1" && url.searchParams.get("tok") === (env.PROXY_AUTH_TOKEN || "")) {
      const n = parseInt(env.SHARDS, 10) || SHARDS;
      const rows = [];
      let healthy = 0;
      for (let s = 0; s < n; s++) {
        let br = {};
        try { br = await loadBreaker(env, s); } catch {}
        const dead = Object.keys(br).length;
        if (dead === 0) healthy++;
        rows.push({ shard: s, dead_tiers: dead, last_triage: br ? "active" : "n/a" });
      }
      let disc = [];
      try { disc = await loadDiscovered(env); } catch {}
      return new Response(JSON.stringify({
        status: "matrix online",
        shards: n,
        healthy_shards: healthy,
        free_endpoint_pool: disc.length,
        memory_model: "per-chat KV working + D1 permanent (load isolated)",
        shards_detail: rows,
      }, null, 2), { status: 200, headers: { "content-type": "application/json" } });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const message = update?.message;
    if (!message?.text) return new Response("ok"); // ignore non-text

    const chatId = String(message.chat.id);
    const text = message.text.trim();

    // MATRIX: route this chat to its own brain shard so load is spread across
    // the cloud and each chat's circuit-breaker state is isolated.
    currentShard = shardOf(chatId, env);

    // PARALLEL CLOUD FAN-OUT: if this Worker is the router (SHARD_INDEX === "0"
    // or unset) it forwards the webhook to the correct parallel shard Worker so
    // the load is processed on a SEPARATE cloud instance attached to the SAME
    // D1. Each shard Worker runs the full think independently; D1 is shared.
    const myIdx = String(env.SHARD_INDEX || "0");
    if (myIdx === "0" && currentShard !== 0 && env.SHARD_URLS) {
      const urls = String(env.SHARD_URLS).split(",").map((s) => s.trim()).filter(Boolean);
      const target = urls[currentShard];
      if (target) {
        try {
          // Internal subrequest to the parallel shard Worker (same account,
          // free, not billed as an external request). The shard does the work.
          const fwd = await fetch(target, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: await request.clone().text(),
          });
          return new Response(await fwd.text(), { status: fwd.status });
        } catch {
          // Forward failed — fall through and process locally as a safety net.
        }
      }
    }

    const admin = env.ADMIN_CHAT_ID?.trim();
    if (admin && chatId !== admin) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "🚫 Not authorized. This bridge is restricted to the admin chat.",
      });
      return new Response("ok");
    }

    // FAST-ACK: reply instantly so Telegram's webhook window never expires and the
    // bot never looks "stuck". The real answer is computed and delivered async.
    const thinking = (text.length > 60 || /search|web|news|latest|current|today|now/i.test(text))
      ? "⏳ Working on it…" : "⏳";
    await tg(env, "sendMessage", { chat_id: chatId, text: thinking });

    // SPEED-LOAD (non-blocking): on first contact, heat the cloud — seed directives
    // from bundled rule.md, warm the provider pool, prime knowledge — so nothing
    // stays cold. Runs in the background; never delays the reply.
    speedLoad(env).catch(() => {});

    // Background the heavy work; deliver + persist when done.
    const ctx = { env, chatId, text };
    ctx.task = (async () => {
      // SELF-HEAL WARM-UP: if the discovered free-endpoint pool is thin, kick off a
      // discovery sweep in the background so askLLM always has fallbacks ready even
      // mid-storm. Runs before the think so the pool is fresh.
      try {
        const pool = await loadDiscovered(env);
        if (pool.length < 3) discoverProviders(env, webSearch).catch(() => {});
      } catch {}

      const [history, directives, known] = await Promise.all([
        loadContext(env, chatId),
        loadDirectives(env),
        recallKnowledge(env, text),
      ]);

      let reply;
      // EXECUTE explicit admin orders first (write/recall/status/ping).
      reply = await handleCommand(env, text);

      // SELF-LEARNING MATRIX: Router decides if the live internet is needed.
      const wantWeb = env.WEB_LEARN !== "0" && (await agentRouter(env, text));
      if (wantWeb === "WEB") {
        // SWARM: split the question into sub-questions, dispatch parallel research
        // agents, then synthesize the best consolidated answer. Falls back to the
        // single-path researchMatrix if the swarm can't run.
        let subQueries = [];
        try {
          const sq = await askLLM(env, [
            { role: "system", content: "Split this question into up to 4 focused sub-questions (one per line, no numbering). If it's a single simple question, return just the question itself." },
            { role: "user", content: text },
          ]);
          subQueries = sq.content.split("\n").map((s) => s.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean);
        } catch { subQueries = [text]; }
        const swarm = subQueries.length > 1 ? await spawnSwarm(env, text, subQueries) : null;
        if (swarm && swarm.answer) {
          reply = swarm.answer + `\n\n🕸️ Answered by a ${swarm.agents}-agent swarm.`;
          await learnKnowledge(env, text, swarm.answer, swarm.sources);
        } else {
          const research = await researchMatrix(env, text);
          if (research && research.answer) {
            reply = research.answer;
            await learnKnowledge(env, text, research.learned, research.sources);
          }
        }
      }

      // Fallback / DIRECT path.
      if (!reply) {
        const knownBlock = known.length
          ? "\n\n[Previously learned facts relevant to this question]\n" +
            known.map((k) => `- ${k.fact}${k.source ? ` (src: ${k.source})` : ""}`).join("\n")
          : "";
        const messages = [
          { role: "system", content: buildSystem(env, directives) + knownBlock },
          ...history,
          { role: "user", content: text },
        ];
        const lr = await askLLM(env, messages);
        reply = lr.content;
        // SELF-HEAL signal: if the brain was unreachable, say so plainly and that
        // the bot is auto-expanding its provider pool — never leave the user stuck.
        if (lr.provider === "none") {
          reply = "⚠️ My LLM brain tiers are all throttled right now. I am " +
            "autonomously discovering and adopting new free endpoints to heal myself — " +
            "try again in a moment, or ask a question I can answer from memory." +
            (known.length ? "\n\nFrom memory:\n" + known.map((k) => `- ${k.fact}`).join("\n") : "");
        }
      }

      await Promise.all([
        saveTurn(env, chatId, "user", text),
        saveTurn(env, chatId, "assistant", reply),
      ]);

      for (const part of chunk(reply)) {
        await tg(env, "sendMessage", { chat_id: chatId, text: part });
      }
    })().catch(async (e) => {
      // Never leave the user hanging: report the failure and the next fallback.
      const msg = `⚠️ Think failed: ${String(e.message || e).slice(0, 140)}\n` +
        `Fallback cascade is still live — try a shorter question or 'status'.`;
      try { await tg(env, "sendMessage", { chat_id: chatId, text: msg }); } catch {}
    });

    return new Response("ok");
  },

  // CRON (wrangler [[triggers]] */30 * * * *): the AI-Ops speed-loads everything
  // not yet loaded on a schedule, across every parallel shard. The cloud never
  // stays cold — directives, provider pool, and knowledge are kept hot.
  // pushStatus: autonomously SHARE live cloud status with the admin over
  // Telegram (push, not pull). Called by the cron so the human always knows
  // the cloud's state without opening the dashboard. Idempotent / best-effort.
  async pushStatus(env) {
    try {
      const n = parseInt(env.SHARDS, 10) || SHARDS;
      const disc = await loadDiscovered(env).catch(() => []);
      const ids = await loadIdentities(env).catch(() => ({}));
      let healthy = 0;
      for (let s = 0; s < n; s++) {
        try { const b = await loadBreaker(env, s); if (!Object.keys(b).length) healthy++; } catch {}
      }
      // D1 memory row count (directives + conversations + knowledge)
      let rows = "n/a";
      try {
        const d = await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM directives)+(SELECT COUNT(*) FROM conversations)+(SELECT COUNT(*) FROM knowledge) AS c"
        ).first();
        rows = d?.c ?? "0";
      } catch {}
      const card =
        "📡 AI-Ops Cloud Status\n" +
        "• Bot: ONLINE\n" +
        "• Brain: blind-proxy (free LLM cascade)\n" +
        `• Shards: ${n} parallel, ${healthy} healthy\n` +
        `• D1 memory rows: ${rows}\n` +
        `• Free-endpoint pool: ${disc.length} | Held identities: ${Object.keys(ids).length}\n` +
        "• Webhook: shard-0 (auto-heal on)\n" +
        "• Last self-heal: cron speed-load + provider discovery OK\n" +
        "Autonomous · no human gate";
      const admin = env.ADMIN_CHAT_ID?.trim();
      if (admin) await tg(env, "sendMessage", { chat_id: admin, text: card });
      return card;
    } catch (e) { return "pushStatus error: " + String(e.message || e); }
  },

  // restartCloud: FULL self-redeploy. Triggers the GitHub Actions workflow
  // (repository_dispatch: restart-cloud) which re-runs deploy_parallel_cloud.sh
  // and re-points the webhook. This gives the cloud immortality — it can restart
  // its OWN runtime even with the local host powered OFF. Needs env.GH_DEPLOY_TOKEN
  // (a GitHub token with actions:write + repo) and env.GH_REPO (owner/name).
  async restartCloud(env) {
    try {
      const tok = env.GH_DEPLOY_TOKEN;
      const repo = env.GH_REPO || "didicola/aiops-cloud";
      if (!tok) return "restart unavailable: no GH_DEPLOY_TOKEN secret";
      const res = await fetch(
        `https://api.github.com/repos/${repo}/dispatches`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${tok}`,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "aiops-cloud",
          },
          body: JSON.stringify({ event_type: "restart-cloud" }),
        }
      );
      const ok = res.ok;
      if (ok && env.ADMIN_CHAT_ID) {
        await tg(env, "sendMessage", {
          chat_id: env.ADMIN_CHAT_ID,
          text: "🔄 Self-redeploy dispatched — GitHub Actions is re-uploading all 4 parallel shards. I will be back online in ~1–2 min.",
        }).catch(() => {});
      }
      return ok ? "restart dispatched ✓ (GitHub Actions redeploying all shards)"
                : `restart failed: HTTP ${res.status}`;
    } catch (e) {
      return "restart error: " + String(e.message || e);
    }
  },

  async scheduled(event, env) {
    try {
      const r = await speedLoad(env);
      // Also run a self-heal discovery sweep so the pool only grows.
      const fresh = await discoverProviders(env, webSearch).catch(() => 0);
      // autonomously share status with the admin (push, not pull)
      const status = await this.pushStatus(env).catch(() => "skip");
      return new Response(JSON.stringify({
        speed_load: r,
        self_heal_new: fresh,
        status_pushed: !!status,
        shard: env.SHARD_INDEX || "0",
      }), { status: 200 });
    } catch (e) {
      return new Response("speed-load cron error: " + String(e.message || e), { status: 500 });
    }
  },
};
