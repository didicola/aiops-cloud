const http = require("http");

const PORT = parseInt(process.env.PORT || "18920", 10);
const EON_AGENT = "http://127.0.0.1:18922";
const REFINEMENT_AGENT = "http://127.0.0.1:18923";

async function fetchPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(opts, (res) => {
      let r = "";
      res.on("data", (c) => (r += c));
      res.on("end", () => resolve(r));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/eon") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const input = JSON.parse(body);
        const userMessage = input.text || "";
        const chatId = input.chat_id || 0;
        console.log(`Relay /eon: ${userMessage.slice(0, 50)}`);

        let refinementResult = "";
        try {
          const refBody = { text: userMessage, history: input.history || [], chat_id: chatId };
          refinementResult = await fetchPost(REFINEMENT_AGENT, refBody);
          const parsed = JSON.parse(refinementResult);
          if (parsed.answer) refinementResult = parsed.answer;
        } catch (e) {
          console.error(`Refinement failed: ${e.message}`);
          try {
            const eonBody = { text: userMessage, chat_id: chatId };
            refinementResult = await fetchPost(EON_AGENT, eonBody);
            const parsed = JSON.parse(refinementResult);
            if (parsed.answer) refinementResult = parsed.answer;
          } catch (e2) {
            console.error(`Eon fallback failed: ${e2.message}`);
            refinementResult = "Eon relay chain unavailable";
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answer: refinementResult }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", refinement: REFINEMENT_AGENT }));
  } else {
    res.writeHead(200);
    res.end("parallel-world-relay on :18920");
  }
});

server.listen(PORT, () => console.log(`parallel-world-relay on :${PORT}, refinement=${REFINEMENT_AGENT}`));
