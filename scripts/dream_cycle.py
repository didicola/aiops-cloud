import requests, hashlib, json, os, time, sys
from datetime import datetime, timezone

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
if not BOT_TOKEN:
    print("ERROR: TELEGRAM_BOT_TOKEN not set")
    sys.exit(1)
ADMIN_ID = os.environ.get("ADMIN_CHAT_ID", "6663994526")
POLL_SLEEP = int(os.environ.get("POLL_SLEEP", "60"))  # 5 min for GH runner, 60s for local
OFFSET_FILE = "/tmp/dream_offset"
ENABLE_LLM = os.environ.get("ENABLE_LLM", "0") == "1"

GITHUB_SHA = os.environ.get("GITHUB_SHA", "local")

def eon_consensus(message_text: str) -> dict:
    msg_hash = hashlib.sha256(message_text.encode()).hexdigest()
    seed = int(msg_hash[:16], 16)
    delegations = 1000
    votes = {}
    for i in range(delegations):
        h = hashlib.sha256(f"{seed}:{i}:eon".encode()).hexdigest()
        choice = chr(ord('a') + (int(h[:8], 16) % 26))
        votes[choice] = votes.get(choice, 0) + 1
    top = max(votes, key=votes.get) if votes else '?'
    return {"delegations": delegations, "votes": votes, "top_choice": top, "consensus_hash": hashlib.sha256(message_text.encode()).hexdigest()[:12]}

def call_llm(message_text: str) -> str:
    try:
        payload = {
            "model": "freebuff/deepseek-v4-flash",
            "messages": [
                {"role": "system", "content": "You are Eon, a swarm intelligence. Reply concisely."},
                {"role": "user", "content": message_text}
            ]
        }
        r = requests.post("http://127.0.0.1:8090/v1/chat/completions",
                         json=payload, timeout=30)
        if r.status_code == 200:
            return r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"LLM call failed: {e}")
    return ""

def send_reply(chat_id: int, text: str):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    r = requests.post(url, json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}, timeout=10)
    return r.status_code == 200

def get_updates(offset: int = 0):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates"
    params = {"offset": offset, "timeout": POLL_SLEEP if POLL_SLEEP < 30 else 30}
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=POLL_SLEEP + 5)
            if r.status_code == 200:
                return r.json().get("result", [])
        except Exception as e:
            print(f"getUpdates attempt {attempt+1} failed: {e}")
            time.sleep(2)
    return []

def dream_cycle():
    last_offset = 0
    if os.path.exists(OFFSET_FILE):
        with open(OFFSET_FILE) as f:
            try: last_offset = int(f.read().strip())
            except: pass
    updates = get_updates(last_offset)
    for upd in updates:
        upd_id = upd.get("update_id", 0)
        msg = upd.get("message") or upd.get("channel_post") or {}
        chat_id = msg.get("chat", {}).get("id")
        text = msg.get("text", "")
        if not chat_id or not text:
            last_offset = max(last_offset, upd_id + 1)
            continue
        print(f"[{datetime.now(timezone.utc).isoformat()}] Message from {chat_id}: {text[:50]}")
        if ENABLE_LLM:
            reply = call_llm(text)
            if reply:
                send_reply(chat_id, reply)
                print(f"LLM reply sent: {reply[:60]}")
        else:
            consensus = eon_consensus(text)
            reply_lines = [
                f"    ᛏ {consensus['delegations']} delegates",
                f"    ᛏ Consensus: '{consensus['top_choice']}' ({consensus['consensus_hash']})",
                f"    ᛏ Eon v0.16 | GH:{GITHUB_SHA[:8]}"
            ]
            send_reply(chat_id, "\n".join(reply_lines))
            print(f"Hash consensus reply sent: {consensus['top_choice']} {consensus['consensus_hash']}")
        last_offset = max(last_offset, upd_id + 1)
    with open(OFFSET_FILE, "w") as f:
        f.write(str(last_offset))

if __name__ == "__main__":
    print(f"Dream Cycle v0.16 starting, LLM={'ON' if ENABLE_LLM else 'OFF'}, poll={POLL_SLEEP}s")
    if ENABLE_LLM:
        single_start = os.environ.get("SINGLE_CYCLE", "0")
        if single_start == "1":
            dream_cycle()
            sys.exit(0)
    while True:
        try:
            dream_cycle()
        except Exception as e:
            print(f"Cycle error: {e}")
        time.sleep(1)
