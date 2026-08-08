/* eon-hub.worker.js — own-cloud GitHub alternative (EON HUB).
 *
 * Sovereign code hub living entirely inside OUR Cloudflare account. It stores
 * repos, files, commits and branches in our own D1+KV — no earthly GitHub
 * required as the source of truth. GitHub (or any mirror) is only a BACKUP.
 *
 * API (all JSON, Bearer AUTH_TOKEN optional via env):
 *   GET  /                         -> web UI + API help
 *   POST /repos                    {name, desc}            create repo
 *   GET  /repos                    list repos
 *   GET  /repos/:name              repo info + refs
 *   DELETE /repos/:name            delete repo
 *   PUT  /repos/:name/refs/:branch {sha,message,parent,files:{path:content}}  commit
 *   GET  /repos/:name/refs/:branch            show ref (latest commit)
 *   GET  /repos/:name/refs/:branch/log        commit log
 *   GET  /repos/:name/refs/:branch/tree       list files (latest commit)
 *   GET  /repos/:name/refs/:branch/blob?path=x  raw file content
 *   POST /repos/:name/mirror       {provider, remote, token}  set mirror (backup target)
 *
 * Storage: D1 table repos + commits + files(indexed in KV for speed).
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function bad(msg) {
  return json({ error: msg }, 400);
}

function notfound(msg = "not found") {
  return json({ error: msg }, 404);
}

function authed(request, env) {
  const h = request.headers.get("authorization") || "";
  const t = env.AUTH_TOKEN;
  if (!t) return true;
  return h === `Bearer ${t}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  name TEXT PRIMARY KEY,
  desc TEXT DEFAULT '',
  created INTEGER DEFAULT 0,
  mirror_provider TEXT,
  mirror_remote TEXT,
  mirror_token TEXT
);
CREATE TABLE IF NOT EXISTS commits (
  repo TEXT,
  sha TEXT,
  branch TEXT,
  parent TEXT,
  message TEXT,
  author TEXT DEFAULT 'eon-hub',
  ts INTEGER,
  files TEXT,        -- JSON {path: content}
  PRIMARY KEY (repo, sha)
);
CREATE INDEX IF NOT EXISTS idx_commits_repo_branch ON commits(repo, branch);
`;

async function init(env) {
  if (!env.DB) return;
  try {
    await env.DB.exec(SCHEMA);
  } catch (e) {
    // already initialized or D1 unavailable
  }
}

function shafy(seed) {
  // deterministic-ish short sha for our own-hub commits
  let h = 0x811c9dc5;
  const s = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h >>> 0) * 0x01000193;
  }
  return ("00000000" + h.toString(16)).slice(-8) + Date.now().toString(16).slice(-8);
}

async function repoExists(env, name) {
  const row = await env.DB.prepare("SELECT name FROM repos WHERE name=?").bind(name).first();
  return !!row;
}

function parseRepo(parts) {
  // /repos/:name/refs/:branch/blob -> ['repos', name, 'refs', branch, 'blob']
  if (parts[0] !== "repos") return null;
  const name = decodeURIComponent(parts[1] || "");
  const rest = parts.slice(2);
  return { name, rest };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.split("/").filter(Boolean);
  const method = request.method;
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);
  await init(env);

  // GET / -> help
  if (path.length === 0) {
    if (method === "GET") {
      return new Response(HTML_UI, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
      });
    }
    return bad("method not allowed");
  }

  // ---- repo list / create ----
  if (path.length === 1 && path[0] === "repos") {
    if (method === "GET") {
      const rows = await env.DB.prepare("SELECT name, desc, created, mirror_remote FROM repos ORDER BY name").all();
      return json({ repos: rows.results || [] });
    }
    if (method === "POST") {
      const body = await request.json().catch(() => null);
      const name = (body && body.name || "").trim();
      if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return bad("invalid repo name");
      if (await repoExists(env, name)) return bad("repo already exists");
      await env.DB.prepare("INSERT INTO repos (name, desc, created) VALUES (?,?,?)")
        .bind(name, body.desc || "", Date.now()).run();
      return json({ ok: true, repo: name });
    }
    return bad("method not allowed");
  }

  // ---- repo-level ops ----
  const p = parseRepo(path);
  if (!p) return bad("unknown path");
  const { name, rest } = p;

  if (rest.length === 0) {
    if (method === "DELETE") {
      if (!(await repoExists(env, name))) return notfound("repo");
      await env.DB.prepare("DELETE FROM commits WHERE repo=?").bind(name).run();
      await env.DB.prepare("DELETE FROM repos WHERE name=?").bind(name).run();
      const key = `files:${name}:`;
      const list = await env.VOL.list({ prefix: key });
      for (const k of list.keys) await env.VOL.delete(k.name);
      return json({ ok: true, deleted: name });
    }
    if (method === "GET") {
      const repo = await env.DB.prepare("SELECT * FROM repos WHERE name=?").bind(name).first();
      if (!repo) return notfound("repo");
      const refs = await env.DB.prepare(
        "SELECT branch, sha, message, ts FROM commits WHERE repo=? AND sha IN (SELECT MAX(sha) FROM commits WHERE repo=? GROUP BY branch) GROUP BY branch"
      ).bind(name, name).all();
      return json({ repo, refs: refs.results || [] });
    }
    if (method === "POST") {
      // mirror target config
      const body = await request.json().catch(() => null);
      if (!body || !body.provider) return bad("provider required (github)");
      await env.DB.prepare("UPDATE repos SET mirror_provider=?, mirror_remote=?, mirror_token=? WHERE name=?")
        .bind(body.provider, body.remote || "", body.token || "", name).run();
      return json({ ok: true, mirror: { provider: body.provider, remote: body.remote } });
    }
    return bad("method not allowed");
  }

  // ---- refs operations: /repos/:name/refs/:branch[/log|tree|blob] ----
  if (rest[0] === "refs") {
    const branch = decodeURIComponent(rest[1] || "");
    if (!branch) return bad("branch required");
    const sub = rest[2] || "";

    if (method === "PUT" && !sub) {
      // create/append commit
      const body = await request.json().catch(() => null);
      if (!body) return bad("body required");
      const files = body.files || {};
      const parent = body.parent || "";
      const message = body.message || "update " + Object.keys(files).length + " file(s)";
      const author = body.author || "eon-hub";
      const sha = shafy(name + branch + message + JSON.stringify(files) + Date.now());
      const ts = Date.now();
      const key = `files:${name}:${branch}:${sha}`;
      await env.VOL.put(key, JSON.stringify(files));
      await env.DB.prepare(
        "INSERT OR REPLACE INTO commits (repo,sha,branch,parent,message,author,ts,files) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(name, sha, branch, parent, message, author, ts, key).run();
      return json({ ok: true, repo: name, branch, sha, message, ts });
    }

    if (method === "GET") {
      if (!sub) {
        const row = await env.DB.prepare(
          "SELECT * FROM commits WHERE repo=? AND branch=? ORDER BY ts DESC LIMIT 1"
        ).bind(name, branch).first();
        if (!row) return notfound("branch " + branch);
        return json({ repo: name, branch, sha: row.sha, parent: row.parent, message: row.message, ts: row.ts, author: row.author });
      }
      if (sub === "log") {
        const rows = await env.DB.prepare(
          "SELECT sha,parent,message,author,ts FROM commits WHERE repo=? AND branch=? ORDER BY ts DESC LIMIT 100"
        ).bind(name, branch).all();
        return json({ repo: name, branch, commits: rows.results || [] });
      }
      if (sub === "tree") {
        const row = await env.DB.prepare(
          "SELECT * FROM commits WHERE repo=? AND branch=? ORDER BY ts DESC LIMIT 1"
        ).bind(name, branch).first();
        if (!row) return notfound("branch " + branch);
        const files = await env.VOL.get(row.files, "json").catch(() => null);
        const tree = Object.keys(files || {}).map((p) => ({ path: p, size: ((files[p] || "").length) }));
        return json({ repo: name, branch, sha: row.sha, files: tree });
      }
      if (sub === "blob") {
        const p = url.searchParams.get("path");
        if (!p) return bad("path query param required");
        const row = await env.DB.prepare(
          "SELECT * FROM commits WHERE repo=? AND branch=? ORDER BY ts DESC LIMIT 1"
        ).bind(name, branch).first();
        if (!row) return notfound("branch " + branch);
        const files = await env.VOL.get(row.files, "json").catch(() => null);
        if (!files || !(p in files)) return notfound("path " + p);
        return json({ repo: name, branch, path: p, content: files[p] });
      }
      return bad("unknown ref op: " + sub);
    }
    return bad("method not allowed");
  }

  return bad("unknown path");
}

async function scheduled(env) {
  // reserved: periodic mirror->backup pushes can hook here later
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
    try {
      return await handle(request, env);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
  async scheduled(_c, env) {
    await scheduled(env);
  },
};

const HTML_UI = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>EON HUB — own-cloud code hub</title>
<style>
body{font-family:ui-monospace,monospace;background:#0d1117;color:#c9d1d9;margin:0;padding:24px}
h1{color:#58a6ff;font-size:22px}a{color:#58a6ff;text-decoration:none}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:12px 0}
input,textarea,button{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:8px;margin:4px}
button{background:#238636;border:none;cursor:pointer}button:active{opacity:.8}
pre{background:#0d1117;padding:12px;border-radius:6px;overflow:auto;max-height:400px;border:1px solid #30363d}
code{color:#79c0ff}
</style></head><body>
<h1>ᛏ EON HUB — own-cloud code hub</h1>
<p>Everything inside our own cloud. GitHub is only a backup.</p>
<div class="card"><h3>Repos</h3><input id="n" placeholder="repo name"/><input id="d" placeholder="description"/>
<button onclick="mk()">create</button> <button onclick="ls()">refresh</button>
<div id="repos"></div></div>
<div class="card"><h3>Repo</h3><input id="r" placeholder="repo"/><input id="b" value="main" placeholder="branch"/>
<button onclick="tree()">tree</button><button onclick="log()">log</button>
<div id="out"><pre></pre></div></div>
<script>
async function api(m,p,b){const o={method:m,headers:{'Content-Type':'application/json'}};if(b)o.body=JSON.stringify(b);const r=await fetch(p,o);return {st:r.status,js:await r.json().catch(()=>({}))};}
async function mk(){const r=await api('POST','/repos',{name:n.value,desc:d.value});show(r);ls();}
async function ls(){const r=await api('GET','/repos');const el=document.getElementById('repos');
 el.innerHTML=(r.js.repos||[]).map(x=>'<div>'+x.name+' — '+(x.desc||'')+' <a href="#'+x.name+'">[open]</a></div>').join('')||'(empty)';}
async function tree(){const r=await api('GET','/repos/'+r.value+'/refs/'+b.value+'/tree');show(r);}
async function log(){const r=await api('GET','/repos/'+r.value+'/refs/'+b.value+'/log');show(r);}
function show(r){document.querySelector('#out pre').textContent=r.st+' '+JSON.stringify(r.js,null,2);}
ls();
</script></body></html>`;
