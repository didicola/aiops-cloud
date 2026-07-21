const http = require("http");
const { execSync } = require("child_process");
const PORT = parseInt(process.env.PORT || "19000", 10);

function torSocksRequest(host, port, path, method = "GET", body = null) {
  const { spawn } = require("child_process");
  const curlArgs = [
    "--socks5", "127.0.0.1:9050",
    "--max-time", "15",
    "-s",
    "-X", method,
  ];
  if (body) curlArgs.push("-d", JSON.stringify(body), "-H", "Content-Type: application/json");
  curlArgs.push(`http://${host}:${port}${path}`);
  return new Promise((resolve, reject) => {
    const proc = spawn("curl", curlArgs);
    let out = "", err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`curl ${code}: ${err.slice(0, 100)}`));
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const input = JSON.parse(body);
        const result = await torSocksRequest(
          input.host || "api.telegram.org",
          input.port || 80,
          input.path || "/",
          input.method || "GET",
          input.body || null
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
  } else {
    res.writeHead(200);
    res.end("tor-ingress-bridge on :19000");
  }
});
server.listen(PORT, () => console.log(`tor-ingress-bridge on :${PORT}`));
