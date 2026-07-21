"""Cloud Sentinel: Autonomous sentinel that spawns delegates across GH runners, maintains webhook, and enforces cluster integrity."""

import os
import sys
import json
import time
import hashlib
import subprocess
import traceback
from datetime import datetime, timezone

SENTINEL_VERSION = "0.16.0"
SENTINEL_SHA = hashlib.sha256(f"cloud-sentinel-v{SENTINEL_VERSION}".encode()).hexdigest()[:12]

log_channel_id = os.environ.get("LOG_CHANNEL_ID", "6241685067")
tg_bot_lock = os.environ.get("TELEGRAM_BOT_TOKEN", "")
if tg_bot_lock and tg_bot_lock.startswith("<") and tg_bot_lock.endswith(">"):
    tg_bot_lock = os.environ.get("TELEGRAM_BOT_TOKEN_UNWRAPPED", tg_bot_lock.strip("<>"))
ADMIN_CHAT_ID = 6663994526

def log(msg: str):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    with open("/tmp/cloud_sentinel.log", "a") as f:
        f.write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", flush=True)

def tg_send(text: str, chat_id=None):
    if not tg_bot_lock:
        return
    import urllib.request
    cid = chat_id or ADMIN_CHAT_ID
    data = json.dumps({"chat_id": cid, "text": text[:4000], "parse_mode": "Markdown"}).encode()
    url = f"https://api.telegram.org/bot{tg_bot_lock}/sendMessage"
    try:
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=15)
        log(f"tg_send({cid}): {resp.status}")
    except Exception as e:
        log(f"tg_send failed: {e}")

GH_REPO = os.environ.get("GITHUB_REPOSITORY", "didicola/aiops-cloud")
GH_TOKEN = os.environ.get("GH_TOKEN", os.environ.get("GITHUB_TOKEN", ""))
if GH_TOKEN and GH_TOKEN.startswith("<"):
    GH_TOKEN = GH_TOKEN.strip("<>")

TG_WEBHOOK_URL = os.environ.get("TG_WEBHOOK_URL", "")

def ensure_tunnel():
    if not tg_bot_lock:
        return
    import urllib.request
    current = TG_WEBHOOK_URL
    if not current:
        return
    url = f"https://api.telegram.org/bot{tg_bot_lock}/getWebhookInfo"
    try:
        resp = json.loads(urllib.request.urlopen(url, timeout=10).read())
        cur = resp.get("result", {}).get("url", "")
        log(f"Current webhook: {cur}")
        # INTENT: Do NOT auto-heal webhook — local tunnel is authoritative
        # Cloud sentinel runs on GH runner, local tunnel on dev machine
        # If webhook differs from current tunnel, notify but do NOT change
    except Exception as e:
        log(f"webhook check failed: {e}")

def dispatch_gh_action(action_type: str, payload: dict = None):
    if not GH_TOKEN or GH_TOKEN.startswith("<"):
        log(f"GH_TOKEN not available, skipping dispatch {action_type}")
        return
    import urllib.request
    data = json.dumps({"event_type": action_type, "client_payload": payload or {}}).encode()
    url = f"https://api.github.com/repos/{GH_REPO}/dispatches"
    req = urllib.request.Request(url, data=data,
                                 headers={"Authorization": f"Bearer {GH_TOKEN}",
                                          "Accept": "application/vnd.github.v3+json",
                                          "Content-Type": "application/json"},
                                 method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        log(f"dispatch {action_type}: {resp.status}")
    except Exception as e:
        log(f"dispatch {action_type} failed: {e}")

def check_for_updates():
    pass

CYCLE_INTERVAL = 1800

def sentinel_loop():
    log(f"Cloud Sentinel v{SENTINEL_VERSION} ({SENTINEL_SHA}) started. Cycle={CYCLE_INTERVAL}s")
    log(f"WEBHOOK_URL={TG_WEBHOOK_URL}")
    while True:
        try:
            ensure_tunnel()
            check_for_updates()
            time.sleep(CYCLE_INTERVAL)
        except KeyboardInterrupt:
            log("Sentinel stopped by user")
            break
        except Exception as e:
            log(f"Cycle error: {e}\n{traceback.format_exc()}")
            time.sleep(60)

if __name__ == "__main__":
    sentinel_loop()
