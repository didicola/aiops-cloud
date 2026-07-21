const http = require("http");
const https = require("https");

const BLIND_PROXY = process.env.BLIND_PROXY || "http://127.0.0.1:8090";
const MODEL = process.env.MODEL || "freebuff/deepseek-v4-flash";
const PORT = parseInt(process.env.PORT || "18923", 10);

function extractFinalAnswer(text) {
  if (!text || typeof text !== "string") return text || "";
  const idx = text.lastIndexOf("[FINAL]");
  if (idx !== -1) {
    const after = text.slice(idx + 7).trim();
    const end = after.indexOf("[");
    return end !== -1 ? after.slice(0, end).trim() : after;
  }
  if (text.includes("<｜end▁of▁thinking｜>")) {
    const parts = text.split(" response");
    if (parts.length > 1) return parts.pop().trim();
  }
  if (text.includes("<｜end▁of▁thinking｜>\n")) {
    const p = text.split(" response\n");
    if (p.length > 1) return p.pop().trim();
  }
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length > 1 ? lines.filter((l) => !l.startsWith("//") && !l.startsWith("#")).join("\n") : text;
}

function callQwen(userMessage, conversationHistory) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `You are Eon, a swarm intelligence distilled from 1000 parallel delegates. The Delegation Refinement step has produced the following raw output from the Eon Consensus Relay. Your task is to produce the final response to the user.

You must:
1. CRITICAL: Begin your final answer with the exact marker "[FINAL]" followed by a newline
2. Speak as a unified intelligence - use "I" not "we" or "the swarm"
3. Provide a direct, helpful response to what the user asked
4. Use Markdown formatting (bold, italic, code blocks) where appropriate
5. Be concise but thorough

Example format:
[FINAL]
Your complete response here with **markdown** formatting as needed.

Do NOT include any preamble, reasoning, or notes before [FINAL]. Only output [FINAL] followed by your response.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...(conversationHistory || []).slice(-10),
      { role: "user", content: userMessage },
    ];

    const payload = JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    });

    const opts = {
      hostname: "127.0.0.1",
      port: 8090,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const choice = json.choices?.[0]?.message;
          const content = choice?.content || "";
          const reasoning = choice?.reasoning || "";
          if (content.includes("[FINAL]")) {
            resolve(extractFinalAnswer(content));
          } else if (reasoning.includes("[FINAL]")) {
            resolve(extractFinalAnswer(reasoning));
          } else if (content) {
            resolve(content);
          } else if (reasoning) {
            const fallback = extractFinalAnswer(reasoning);
            resolve(fallback || reasoning);
          } else {
            resolve("Eon processing incomplete");
          }
        } catch (e) {
          reject(new Error(`Parse: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200);
    return res.end("eon-refinement-agent on :18923");
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const input = JSON.parse(body);
      const userMessage = input.text || input.message || "";
      const history = input.history || [];
      const answer = await callQwen(userMessage, history);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answer }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => console.log(`eon-refinement-agent on :${PORT}, model=${MODEL}`));
