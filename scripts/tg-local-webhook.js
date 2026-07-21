const http = require("http");
const https = require("https");

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8940974811:AAE4faGkC-8m02vWF1SxAM7nNHRf9NjsYMs";
const EON_RELAY = "http://127.0.0.1:18920";
const PORT = parseInt(process.env.PORT || "18926", 10);

function telegramApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: "api.telegram.org",
      path: `/bot${TG_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
    };
    const req = https.request(opts, (res) => {
      let r = "";
      res.on("data", (c) => (r += c));
      res.on("end", () => resolve(JSON.parse(r)));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        const msg = update.message || update.channel_post || {};
        const chatId = msg.chat?.id;
        const text = msg.text || "";
        if (chatId && text) {
          console.log(`Webhook: chat=${chatId} text=${text.slice(0, 50)}`);
          const relayRes = await fetch(`${EON_RELAY}/eon`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, source: "telegram" }),
          });
          const reply = await relayRes.text();
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: reply || "Eon relay offline",
            parse_mode: "Markdown",
          });
          console.log(`Reply sent: ${reply.slice(0, 60)}`);
        }
      } catch (e) {
        console.error("Webhook error:", e.message);
      }
      res.writeHead(200);
      res.end("OK");
    });
  } else {
    res.writeHead(200);
    res.end("tg-local-webhook alive");
  }
});

server.listen(PORT, () => console.log(`tg-local-webhook on :${PORT}`));
