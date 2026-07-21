export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/wake" && request.method === "POST") {
      await env.EON_KV.put("last_wake", Date.now().toString());
      return new Response(JSON.stringify({ woken: true, ts: Date.now() }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/status") {
      const lastWake = await env.EON_KV.get("last_wake");
      const uptime = lastWake ? (Date.now() - parseInt(lastWake)) / 1000 : -1;
      return new Response(
        JSON.stringify({
          alive: uptime >= 0 && uptime < 1800,
          last_wake_seconds_ago: uptime,
          quantum: "0/1",
        }),
        { headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Eon Quantum Waker: POST /wake, GET /status", { status: 200 });
  },
};
