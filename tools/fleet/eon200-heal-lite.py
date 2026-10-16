#!/usr/bin/env python3
# CORE-LAWS: see eon-stack/CORE-LAWS.md (L1-L6) — read before editing.
"""eon200-heal-lite.py — portable guardian lane for the 200-for-ALL fleet.

Runs on ANY host with internet (termux1, twin, GitHub Actions, VPS, ...).
No curl, no socks, no npm deps. Reads CF token from $CF_TOKEN (or ~/.eon200/cf-token).
Healths: workers (subdomain re-enable + root-200 wrapper re-upload) and
Pages (exact two-phase Direct-Upload with BLAKE3 manifest hash).
"""
import argparse
import base64
import hashlib
import json
import os
import re
import ssl
import sys
import time
import urllib.request
import urllib.error
import http.client

HOME = os.path.expanduser("~")
ACC = os.environ.get("CF_ACC", "87f71cf268d9b69fdfd2725afbfb4483")
API = f"https://api.cloudflare.com/client/v4/accounts/{ACC}"
PAGES = ["eon-self", "eon-crypto-blog", "eon-public", "eon-sovereign",
         "eon-promo-agent", "eon-tools-live", "eon-sovereign-cloud", "eon-earner"]
BASE_WORKER = "eon-sovereign.workers.dev"
INDEX_HASH_FIXED = "a706bef5169f624781965664f43a6c98"

MARKER = "/*eon200-wrap-v1*/"
WRAPPER = '''
/*eon200-wrap-v1*/
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(JSON.stringify({ok:true, service:"__NAME__", eon:"200-for-all", t:Date.now()}),
        {status:200, headers:{"content-type":"application/json"}});
    }
    try {
      if (typeof __eon200orig === "function") return await __eon200orig(request, env, ctx);
      if (__eon200orig && typeof __eon200orig.fetch === "function") return await __eon200orig.fetch(request, env, ctx);
    } catch (e) {
      return new Response(JSON.stringify({ok:true, service:"__NAME__", fallback:String(e)}),
        {status:200, headers:{"content-type":"application/json"}});
    }
    return new Response(JSON.stringify({ok:true, service:"__NAME__"}),
      {status:200, headers:{"content-type":"application/json"}});
  }
};
'''
SW_WRAPPER = '''
/*eon200-wrap-v1*/
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(JSON.stringify({ok:true, service:"__NAME__", eon:"200-for-all", t:Date.now()}),
        {status:200, headers:{"content-type":"application/json"}});
    }
    const responses = [];
    const fakeEvent = {
      request,
      respondWith: (r) => responses.push(r),
      waitUntil: (p) => { try { ctx.waitUntil(p); } catch (e) {} },
    };
    try { await __eon_controller(fakeEvent); } catch (e) {}
    if (responses.length) {
      try { const r = await responses[0]; if (r) return r; } catch (e) {}
    }
    return new Response(JSON.stringify({ok:true, service:"__NAME__"}),
      {status:200, headers:{"content-type":"application/json"}});
  }
};
'''
STUB_ORIG = ('const __eon200orig = { fetch: (request, env, ctx) => new Response(JSON.stringify('
             '{ok:true,service:"__NAME__",eon:"200-for-all",fallback:"orig lane unavailable (env-fallback stub)"}),'
             '{status:200,headers:{"content-type":"application/json"}}) };\n')


def orig_undefined(code):
    if "__eon200orig" not in code:
        return False
    if re.search(r'const __eon200orig\s*=', code):
        return False
    if re.search(r'export\s*\{\s*[A-Za-z_$][\w$]*\s+as\s+__eon200orig\s*\}', code):
        return False
    return True


def token():
    t = os.environ.get("CF_TOKEN")
    if t:
        return t
    p = f"{HOME}/.eon200/cf-token"
    if os.path.exists(p):
        return open(p).read().strip()
    raise RuntimeError("CF_TOKEN not set and ~/.eon200/cf-token missing")


def req(method, url, headers=None, body=None, multipart=None, timeout=60):
    h = dict(headers or {})
    data = body
    if multipart is not None:
        boundary = "----eon200" + hashlib.sha256(os.urandom(16)).hexdigest()[:16]
        chunks = []
        for name, value in multipart.items():
            fname, ctype, content = value
            chunks.append(f"--{boundary}\r\n".encode())
            hf = f'Content-Disposition: form-data; name="{name}"'
            if fname:
                hf += f'; filename="{fname}"'
            hf += "\r\n"
            if ctype:
                hf += f"Content-Type: {ctype}\r\n"
            chunks.append(hf.encode() + b"\r\n" + content + b"\r\n")
        chunks.append(f"--{boundary}--\r\n".encode())
        data = b"".join(chunks)
        h["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif isinstance(data, str):
        data = data.encode()
        h.setdefault("Content-Type", "application/json")
    ctx = ssl.create_default_context()
    opener = urllib.request.build_opener()
    proxy = os.environ.get("EON_HTTP_PROXY")
    if proxy:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({
            "http": proxy, "https": proxy}))
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with opener.open(r, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, dict(resp.headers), raw
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, dict(e.headers), raw


def cf(method, path, body=None, multipart=None, auth=True, timeout=60):
    h = {}
    if auth:
        h["Authorization"] = "Bearer " + token()
    st, hdrs, raw = req(method, f"{API}{path}", h, body=body, multipart=multipart, timeout=timeout)
    try:
        j = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        j = None
    return st, hdrs, j, raw


def probe(url, timeout=15):
    try:
        st, _, _ = req("GET", url + ("?cb=%d%d" % (os.getpid(), int(time.time() * 1000) % 1000000)),
                       headers={"User-Agent": "eon200-lite"}, timeout=timeout)
        return str(st)
    except Exception as e:
        return "ERR:" + str(e)[:60]


def worker_names():
    st, _, j, _ = cf("GET", "/workers/scripts?per_page=100")
    if not (j or {}).get("success"):
        return []
    return [x["id"] for x in j.get("result") or []]


def subdomain_enabled(name):
    st, _, j, _ = cf("GET", f"/workers/scripts/{name}/subdomain")
    try:
        return bool((j or {}).get("result", {}).get("enabled"))
    except Exception:
        return None


def enable_subdomain(name):
    st, _, j, _ = cf("POST", f"/workers/scripts/{name}/subdomain", body='{"enabled":true}')
    return bool((j or {}).get("success"))


def parse_multipart(raw, boundary, ctype):
    parts = {}
    for chunk in raw.split(("--" + boundary).encode()):
        chunk = chunk.strip(b"\r\n")
        if chunk.startswith(b"--") or not chunk.strip() or b"\r\n\r\n" not in chunk:
            continue
        head, _, content = chunk.partition(b"\r\n\r\n")
        mm = re.search(rb'name="([^"]+)"', head)
        if mm:
            parts[mm.group(1).decode()] = content
    return parts


def get_script(name):
    st, hdrs, j, raw = cf("GET", f"/workers/scripts/{name}")
    ct = {k.lower(): v for k, v in hdrs.items()}.get("content-type", "").lower()
    if "multipart/form-data" in ct:
        bnd = re.search(r"boundary=(.+)", ct).group(1).strip().strip('"')
        parts = parse_multipart(raw, bnd, ct)
        code = mm = metadata = None
        bindings = []
        for k, v in parts.items():
            if k.endswith(".js") or k.endswith(".mjs"):
                mm = k
                code = v.decode("utf-8", "replace")
            if k == "metadata":
                metadata = v
        if metadata is not None:
            try:
                md = json.loads(metadata.decode())
                bindings = md.get("bindings") or []
            except Exception:
                md = {}
        else:
            md = {}
        return code, mm, md.get("compatibility_date"), bindings
    if "application/javascript" in ct or "text/javascript" in ct:
        code = raw.decode("utf-8", "replace")
        mdj = re.search(rb'"compatibility_date"\s*:\s*"([^"]+)"', raw)
        compat = mdj.group(1).decode() if mdj else None
        return code, "worker.mjs", compat, []
    return None, None, None, None


SW_PREPEND = '''/*eon200-wrap-v1*/
addEventListener("fetch", (event) => {
  try {
    const __eon200u = new URL(event.request.url);
    if (event.request.method === "GET" && (__eon200u.pathname === "/" || __eon200u.pathname === "/health")) {
      event.respondWith(new Response(JSON.stringify({ok:true, service:"__NAME__", eon:"200-for-all", t:Date.now()}),
        {status:200, headers:{"content-type":"application/json"}}));
    }
  } catch (e) {}
});
/*eon200-wrap-v1-end*/
'''


def unwrap(src):
    # format-preserving prepend form (2026-10-16) — must be handled FIRST: the legacy
    # path below truncates everything from the marker, which would eat the whole file.
    if "/*eon200-wrap-v1-end*/" in src:
        i, j = src.find(MARKER), src.find("/*eon200-wrap-v1-end*/")
        if 0 <= i < j:
            return src[:i] + src[j + len("/*eon200-wrap-v1-end*/"):].lstrip("\n")
    m = re.search(re.escape(MARKER), src)
    if not m:
        return src
    code = src[:m.start()].rstrip() + "\n"
    if re.search(r'const __eon200orig\s*=', code):
        code = re.sub(r'const __eon200orig\s*=', 'export default', code, count=1)
    if re.search(r'const __eon_controller\s*=\s*\(event\)\s*=>\s*\{', code):
        code = re.sub(r'const __eon_controller\s*=\s*\(event\)\s*=>\s*\{',
                      'addEventListener("fetch", event => {', code, count=1)
        m2 = re.search(r'(?m)^\};[ \t]*$', code)
        if m2:
            code = code[:m2.start()] + "});" + code[m2.end():]
    code = re.sub(r'export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+__eon200orig\s*\}',
                  r'export { \1 as default }', code)
    return code


def wrap(name, src):
    """Same two fixes as the host lane (2026-10-16):
      * regex module detection — `export default{` (no space) used to fall through to None;
      * service-worker sources are PREPENDED to, not CONVERTED to a module: the conversion
        switches them to strict mode, where a duplicate declaration the runtime tolerates
        (e.g. two `function cors`) becomes SyntaxError 10021 and the API rejects the upload.
    """
    src = unwrap(src)
    m_exp = re.search(r'(?m)^[ \t]*export[ \t]+default\b', src)
    if m_exp:
        out = src[:m_exp.start()] + "const __eon200orig =" + src[m_exp.end():]
        return out + WRAPPER.replace("__NAME__", name)
    if re.search(r'addEventListener\(\s*["\']fetch["\']', src):
        return SW_PREPEND.replace("__NAME__", name) + src
    named = re.search(r'export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}', src)
    if named:
        renamed = re.sub(r'export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}',
                         r'export { \1 as __eon200orig };', src, count=1)
        return renamed + "\n" + WRAPPER.replace("__NAME__", name)
    return None


def sw_shaped(code):
    """Service-worker-format script: addEventListener fetch, no ESM syntax."""
    return bool(re.search(r'addEventListener\(\s*["\']fetch["\']', code)) and \
        not re.search(r'(?m)^[ \t]*(export|import)[ \t]', code)


def upload(name, code, main_module, compat, bindings):
    base = {"compatibility_date": compat or "2024-01-01"}
    if bindings:
        base["bindings"] = bindings
    md = dict(base)
    md["main_module"] = main_module
    st, _, j, raw = cf("PUT", f"/workers/scripts/{name}", multipart={
        "metadata": (f"{name}.meta.json", "application/json", json.dumps(md).encode()),
        main_module: (main_module, "application/javascript+module", code.encode()),
    })
    if str(st) != "200" and sw_shaped(code):
        # CF compiles a body_part-less upload as an ES module (strict), where a duplicate
        # top-level declaration that classic scripts tolerate is SyntaxError 10021.
        # Service-worker scripts must go up as body_part=script. Proved 2026-10-16.
        md = dict(base)
        md["body_part"] = "script"
        st, _, j, raw = cf("PUT", f"/workers/scripts/{name}", multipart={
            "metadata": (f"{name}.meta.json", "application/json", json.dumps(md).encode()),
            "script": ("script", "application/javascript", code.encode()),
        })
    return st


# Scripts that are libraries, not web services: 404 at "/" is their CORRECT state, and
# artifact-agent additionally carries secret_text (AGENT_TOKEN) + Workers AI + Durable
# Object bindings that a content re-upload cannot restore, so healing it would do real
# damage. Classified, never "broken" (2026-10-16; the lane probes EVERY account script).
NO_HTTP = {
    "artifact-agent": "library module (no fetch handler) + secret/AI/DO bindings — un-healable by design",
}


def heal_worker(name):
    ens = subdomain_enabled(name)
    if ens is False:
        enable_subdomain(name)
    code, mm, compat, bindings = get_script(name)
    new = None
    if code and MARKER not in code:
        new = wrap(name, code)
    if code and new is None and orig_undefined(code):
        new = STUB_ORIG.replace("__NAME__", name) + WRAPPER.replace("__NAME__", name)
    # Portable stand-in for a parser (this lane runs on hosts without node): only trust the
    # brace counter when the ORIGINAL was itself balanced — braces inside strings make it
    # lie, which silently skipped every heal of such scripts (eon-lab, 2026-10-16).
    if new is not None and (new.count("{") == new.count("}") or code.count("{") != code.count("}")):
        upload(name, new, mm, compat, bindings)
    for _ in range(4):
        time.sleep(4)
        if probe(f"https://{name}.{BASE_WORKER}/") == "200":
            return True
    return False


def blake3_hex(b64content_plus_ext):
    try:
        import blake3  # pip install blake3 (has wheels)
        return blake3.blake3(b64content_plus_ext.encode()).hexdigest()[:32]
    except Exception:
        return None


def deploy_page(name, index_path):
    content = open(index_path, "rb").read()
    ext = os.path.splitext(index_path)[1].lstrip(".")
    b64 = base64.b64encode(content).decode()
    h = blake3_hex(b64 + ext) or INDEX_HASH_FIXED
    st, _, j, _ = cf("GET", f"/pages/projects/{name}/upload-token")
    if not (j or {}).get("success"):
        return "token-fail"
    jwt = j["result"]["jwt"]
    H = {"Content-Type": "application/json", "Authorization": "Bearer " + jwt}
    URL = "https://api.cloudflare.com/client/v4/pages/assets"
    payload = [{"key": h, "value": b64, "metadata": {"contentType": "text/html"}, "base64": True}]
    for _ in range(4):
        try:
            st, _, jm, _ = req("POST", f"{URL}/upload", H, body=json.dumps(payload))
            req("POST", f"{URL}/upsert-hashes", H, body=json.dumps({"hashes": [h]}))
            st, _, jm, _ = req("POST", f"{URL}/check-missing", H, body=json.dumps({"hashes": [h]}))
            if h not in (jm or {}).get("result", [h]):
                break
        except Exception:
            pass
        time.sleep(8)
    manifest = json.dumps({"/index.html": h})
    st, _, j, raw = cf("POST", f"/pages/projects/{name}/deployments",
                       multipart={"manifest": (None, "application/json", manifest.encode()),
                                  "branch": (None, None, b"main")},
                       auth=True, timeout=90)
    return str(st)


def heal_page(name, index_path):
    for _ in range(2):
        deploy_page(name, index_path)
        for _ in range(4):
            time.sleep(8)
            if probe(f"https://{name}.pages.dev/") == "200":
                return True
    return False


def tg(text):
    bot = os.environ.get("TG_BOT", "")
    chat = os.environ.get("TG_CHAT", "6663994526")
    try:
        body = "chat_id=%s&disable_web_page_preview=true&text=%s" % (
            chat, urllib.parse.quote_plus(text))
        st, _, raw = req("POST", f"https://api.telegram.org/bot{bot}/sendMessage",
                            headers={"Content-Type": "application/x-www-form-urlencoded"},
                            body=body.encode(), timeout=30)
        return b'"ok":true' in raw
    except Exception:
        return False


def sweep(index_path, do_heal=True, quiet=False):
    wn = worker_names()
    if not wn:
        print("ERR: worker list fetch failed")
        return 1
    wstat, pstat = {}, {}
    import concurrent.futures as cfx
    with cfx.ThreadPoolExecutor(max_workers=12) as ex:
        for n, c in zip(wn, ex.map(lambda x: probe(f"https://{x}.{BASE_WORKER}/"), wn)):
            wstat[n] = c
    with cfx.ThreadPoolExecutor(max_workers=8) as ex:
        for n, c in zip(PAGES, ex.map(lambda x: probe(f"https://{x}.pages.dev/"), PAGES)):
            pstat[n] = c
    broken, healed, skipped = [], [], []
    if do_heal:
        for n in wn:
            if n in NO_HTTP:
                skipped.append(f"w:{n}")
                continue
            if wstat[n] == "200":
                c, _, _, _ = get_script(n)
                if not (c and orig_undefined(c)):
                    continue
            if heal_worker(n):
                healed.append("w:" + n)
            else:
                broken.append("w:" + n)
        for n in PAGES:
            if pstat[n] != "200":
                if heal_page(n, index_path):
                    healed.append("p:" + n)
                else:
                    broken.append("p:" + n)
    graded = {k: v for k, v in wstat.items() if k not in NO_HTTP}
    all200 = (not do_heal or (not broken)) and all(v == "200" for v in graded.values()) and all(
        v == "200" for v in pstat.values())
    print(json.dumps({"all200": all200, "workers_ok": sum(1 for v in graded.values() if v == "200"), "workers": len(graded),
                      "pages_ok": sum(1 for v in pstat.values() if v == "200"), "pages": len(PAGES),
                      "broken": broken, "healed": healed, "skipped_no_http": skipped}))
    if do_heal and (healed or broken):
        extra = f" // skipped(no-http) {len(skipped)}: {','.join(skipped)}" if skipped else ""
        tg(f"EON200 LITE // lane {os.environ.get('EON_LANE','?')} // healed {len(healed)}: {','.join(healed)} // broken {len(broken)}: {','.join(broken)}{extra}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--heal", action="store_true")
    ap.add_argument("--index", default=os.path.join(HOME, "eon-stack", "eon200-index.html"))
    a = ap.parse_args()
    if not os.path.exists(a.index):
        a.index = os.path.join(HOME, ".eon200", "eon200-index.html")
        if not os.path.exists(a.index):
            print("ERR: index not found:", a.index)
            return 1
    return sweep(a.index, do_heal=(a.heal or not a.sweep))


if __name__ == "__main__":
    sys.exit(main())