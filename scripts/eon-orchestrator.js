/* Eon Orchestrator - Coordinates 1000 parallel delegates and aggregates */
const http = require("http");
const { eon_consensus } = require("./eon-consensus.js");
const PORT = parseInt(process.env.PORT || "18921", 10);
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(200); return res.end("eon-orchestrator"); }
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    try {
      const { text } = JSON.parse(body);
      if (!text) { res.writeHead(400); return res.end(JSON.stringify({error:"text required"})); }
      const consensus = eon_consensus(text);
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ answer: `ᛏ ${consensus.delegations} delegates\nᛏ Consensus: '${consensus.top_choice}' (${consensus.consensus_hash})`, consensus }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
  });
});
server.listen(PORT, () => console.log(`eon-orchestrator on :${PORT}`));
