const http = require('http');
const PORT = 18920;

const LOCAL_BP = 'http://127.0.0.1:8090/v1/chat/completions';

function fetchJSON(url, payload, timeoutMs) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
      rejectUnauthorized: false,
      timeout: timeoutMs || 30000
    };
    const mod = u.protocol === 'https:' ? require('https') : http;
    const req = mod.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ ok: false, status: res.statusCode, data: { error: 'parse error' } }); }
      });
    });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url === '/health') {
    return res.end(JSON.stringify({ ok: true, service: 'delegate-relay', port: PORT, timestamp: Date.now() }));
  }
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/delegate')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) {
        res.writeHead(400); return res.end(JSON.stringify({ error: 'invalid json' }));
      }
      const model = parsed.model || 'auto';
      const messages = parsed.messages || [];
      // Route: try local BP first, fallback to mobazed
      try {
        const r = await fetchJSON(LOCAL_BP, { model, messages, max_tokens: parsed.max_tokens || 512 }, 30000);
        if (r.ok) { res.end(JSON.stringify(r.data)); return; }
        console.error('[delegate] local fail: %s', r.error || r.status);
      } catch(e) { console.error('[delegate] local error: %s', e.message); }
      // Cloud fallback: mobazed think endpoint
      try {
        const mobPayload = { thought: JSON.stringify({task: 'delegate', model, messages}), compute: 'cloud' };
        const u = new URL('https://mobazed.exportdefaultasyncfetchrequestenvconsturl.workers.dev/mobazed/think');
        const opts = {
          hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
          rejectUnauthorized: false, timeout: 45000,
        };
        const mobRes = await new Promise((resolve) => {
          const mReq = require('https').request(opts, r => {
            let b = ''; r.on('data', c => b += c);
            r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({error: 'mobazed parse error'}); } });
          });
          mReq.on('error', e => resolve({error: 'mobazed error: ' + e.message}));
          mReq.on('timeout', () => { mReq.destroy(); resolve({error: 'mobazed timeout'}); });
          mReq.write(JSON.stringify(mobPayload));
          mReq.end();
        });
        console.error('[delegate] mobazed response received');
        res.end(JSON.stringify({ mobazed: mobRes, note: 'processed by cloud delegate' }));
        return;
      } catch(e) {
        console.error('[delegate] mobazed error: %s', e.message);
      }
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'all providers exhausted' }));
    });
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'unknown endpoint' }));
});

server.listen(PORT, () => console.error('[delegate-relay] :%d online', PORT));
