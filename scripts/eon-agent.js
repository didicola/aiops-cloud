/* Eon Agent - Single delegate in the 1000-world swarm */
const http = require("http");
const PORT = parseInt(process.env.PORT || "18922", 10);
const proxy_url = "http://127.0.0.1:8090/v1/chat/completions";
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(200); return res.end("eon-agent"); }
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    try {
      const { text, delegate_id } = JSON.parse(body);
      const delegate_seed = delegate_id || 0;
      const payload = JSON.stringify({
        model: "freebuff/deepseek-v4-flash",
        messages: [
          { role: "system", content: `You are Eon delegate #${delegate_seed}.` },
          { role: "user", content: text }
        ],
        temperature: 1.0,
      });
      const opts = { hostname: "127.0.0.1", port: 8090, path: "/v1/chat/completions", method: "POST",
                     headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } };
      const r = await new Promise((resolve, reject) => {
        const req2 = http.request(opts, r2 => { let d=""; r2.on("data",c=>d+=c); r2.on("end",()=>resolve(d)); });
        req2.on("error", reject); req2.write(payload); req2.end();
      });
      const json = JSON.parse(r);
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ answer: json.choices?.[0]?.message?.content || "" }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
  });
});
server.listen(PORT, () => console.log(`eon-agent on :${PORT}`));
