#!/usr/bin/env bash
# Host egress kill-switch + Tor DNS routing (owns table inet host_egress).
# Authoritative for tor_nat output: flush + re-add canonical rules so reboots
# never accumulate duplicates.
#   - All non-loopback TCP -> Tor TransPort 9040 (SNI/leak free)
#   - All non-loopback UDP DNS (53) -> Tor DNSPort 5353 (closes DNS leak)
#   - VPN tunnels (wg0/tailscale0) kept DIRECT (access preserved)
#   - host_egress drop: anything NOT via Tor/localhost/LAN/Tor-uid/VPN is dropped
set -uo pipefail
TOR_UID=$(id -u debian-tor 2>/dev/null) || TOR_UID=$(id -u tor 2>/dev/null) || TOR_UID=121

# --- tor_nat output: canonical ---
nft flush chain ip tor_nat output 2>/dev/null || true
nft add rule ip tor_nat output oifname { "wg0", "tailscale0" } return
nft add rule ip tor_nat output meta l4proto tcp ip daddr != 127.0.0.0/8 dnat to 127.0.0.1:9041
nft add rule ip tor_nat output udp dport 53 ip daddr != 127.0.0.0/8 dnat to 127.0.0.1:5354

# --- host_egress kill-switch (owned table) ---
nft add table inet host_egress 2>/dev/null || true
nft flush chain inet host_egress output 2>/dev/null || true
nft add chain inet host_egress output '{ type filter hook output priority filter; policy accept; }' 2>/dev/null || nft add chain inet host_egress output
nft add rule inet host_egress output oifname "lo" accept
nft add rule inet host_egress output ct state established,related accept
nft add rule inet host_egress output ip protocol icmp accept
nft add rule inet host_egress output ip daddr 127.0.0.0/8 accept
nft add rule inet host_egress output ip daddr 10.0.0.0/8 accept
nft add rule inet host_egress output ip daddr 172.16.0.0/12 accept
nft add rule inet host_egress output ip daddr 192.168.0.0/16 accept
nft add rule inet host_egress output ip daddr 169.254.0.0/16 accept
nft add rule inet host_egress output meta skuid $TOR_UID accept
nft add rule inet host_egress output oifname { "wg0", "tailscale0" } accept
nft add rule inet host_egress output udp dport 123 accept
nft add rule inet host_egress output drop
echo "host egress kill-switch applied (tor_uid=$TOR_UID)"
