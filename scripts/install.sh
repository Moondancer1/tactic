#!/usr/bin/env bash
# One-shot install/update of Tactic on a VPS, safe for a server that already runs
# other containers. Run from the repository root:
#
#   sudo ./scripts/install.sh --check  tactic.example.com admin@example.com   # preflight only, changes nothing
#   sudo ./scripts/install.sh          tactic.example.com admin@example.com   # install / update
#
# Modes (picked automatically, override with --mode):
#   standalone   ports 80/443 are free: our Caddy takes them and gets a Let's Encrypt cert.
#   proxy        80/443 are already taken by another reverse proxy: our Caddy listens on
#                127.0.0.1:${TACTIC_HTTP_PORT:-8088} (plain HTTP) and the existing proxy must
#                forward the subdomain there (TLS + WebSocket). See docs/DEPLOY.md.
set -euo pipefail

CHECK_ONLY=0
MODE=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --mode) MODE="${2:?--mode needs standalone|proxy}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
DOMAIN="${ARGS[0]:-}"
EMAIL="${ARGS[1]:-}"
HTTP_PORT="${TACTIC_HTTP_PORT:-8088}"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
yel() { printf '\033[33m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
PROBLEMS=0
problem() { red "  ✗ $*"; PROBLEMS=$((PROBLEMS + 1)); }
warn() { yel "  ! $*"; }
ok() { grn "  ✓ $*"; }

[ -f docker-compose.yml ] || { red "Run from the tactic repository (docker-compose.yml not found)"; exit 1; }

ARG_DOMAIN="$DOMAIN"
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi
DOMAIN="${ARG_DOMAIN:-${DOMAIN:-}}"
if [ -f .env ] && [ "$DOMAIN" != "$(grep '^DOMAIN=' .env | cut -d= -f2)" ]; then
  red ".env has DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2), not $DOMAIN — edit .env or remove it"; exit 1
fi
[ -n "$DOMAIN" ] || { red "usage: $0 [--check] [--mode standalone|proxy] <domain> <acme-email>"; exit 1; }

# ---------------------------------------------------------------- system
hdr "System"
. /etc/os-release 2>/dev/null && ok "OS: ${PRETTY_NAME:-unknown}"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
echo "  RAM ${MEM_MB} MB (available ${AVAIL_MB} MB), swap ${SWAP_MB} MB, CPUs $(nproc)"
if [ $((AVAIL_MB + SWAP_MB)) -lt 1500 ]; then
  warn "Less than ~1.5 GB free RAM+swap: the image build (Vite) may get OOM-killed. Add swap:"
  echo "      fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
fi
DISK_GB=$(df -BG --output=avail "$ROOT" | tail -1 | tr -dc 0-9)
[ "${DISK_GB:-0}" -ge 5 ] && ok "Disk free: ${DISK_GB} GB" || warn "Disk free: ${DISK_GB} GB (need ~3–5 GB for images)"

# ---------------------------------------------------------------- docker
hdr "Docker"
if command -v docker >/dev/null 2>&1; then
  ok "$(docker --version)"
  if docker compose version >/dev/null 2>&1; then ok "$(docker compose version | head -1)"; else problem "docker compose plugin missing (apt install docker-compose-plugin)"; fi
  echo "  Running containers (not ours are left untouched):"
  docker ps --format '    {{.Names}}\t{{.Image}}\t{{.Ports}}' || true
else
  problem "Docker not installed: curl -fsSL https://get.docker.com | sh"
fi

# ---------------------------------------------------------------- ports
hdr "Ports"
# Who listens on a port (any address), excluding our own compose project.
listener() { ss -H -lntup "( sport = :$1 )" 2>/dev/null | awk '{print $NF}' | sort -u | tr '\n' ' '; }
ours_running() { docker compose ps -q 2>/dev/null | grep -q .; }
port_busy() {
  local p=$1 proto=${2:-t}
  ss -H -ln"$proto" "( sport = :$p )" 2>/dev/null | grep -q .
}

AUTO_MODE=standalone
for p in 80 443; do
  if port_busy "$p" t; then
    if ours_running && docker compose port caddy "$p" >/dev/null 2>&1; then
      ok "tcp/$p used by our own caddy (update)"
    else
      AUTO_MODE=proxy
      warn "tcp/$p already taken: $(listener "$p")"
    fi
  else
    ok "tcp/$p free"
  fi
done
MODE="${MODE:-$AUTO_MODE}"

check_free() { # port proto label
  if port_busy "$1" "$2"; then
    if ours_running; then ok "$3 $1 in use (probably ours)"; else problem "$3 $1 already in use: $(listener "$1")"; fi
  else ok "$3 $1 free"; fi
}
[ "$MODE" = proxy ] && check_free "$HTTP_PORT" t "tcp (local caddy)"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "  ufw is active — rules will be added for 80/443"
else
  echo "  ufw inactive — open the ports in the hoster's firewall/security group if it has one"
fi

# ---------------------------------------------------------------- DNS
hdr "DNS"
PUBLIC_IP_DETECTED="$(curl -4 -fsS --max-time 5 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
echo "  server public IPv4: ${PUBLIC_IP_DETECTED:-unknown}"
if [ -z "$DNS_IP" ]; then
  problem "$DOMAIN does not resolve. Add an A record: $DOMAIN -> ${PUBLIC_IP_DETECTED:-<server IP>}"
elif [ -n "$PUBLIC_IP_DETECTED" ] && [ "$DNS_IP" != "$PUBLIC_IP_DETECTED" ]; then
  warn "$DOMAIN -> $DNS_IP, but this server is $PUBLIC_IP_DETECTED (ok only if behind a CDN/NAT you control)"
else
  ok "$DOMAIN -> $DNS_IP"
fi

hdr "Result"
echo "  mode: $MODE"
if [ "$MODE" = proxy ]; then
  yel "  Ports 80/443 belong to another proxy. Tactic will listen on 127.0.0.1:$HTTP_PORT;"
  yel "  that proxy must forward https://$DOMAIN -> http://127.0.0.1:$HTTP_PORT (with WebSocket upgrade)."
fi
if [ "$CHECK_ONLY" = 1 ]; then
  [ "$PROBLEMS" -eq 0 ] && grn "  Preflight OK" || red "  $PROBLEMS problem(s) found"
  exit 0
fi
[ "$PROBLEMS" -eq 0 ] || { red "  Fix the problems above first (or run with --check to see them again)"; exit 1; }

# ---------------------------------------------------------------- install
hdr "Install"
if [ ! -f .env ]; then
  [ -n "$EMAIL" ] || { red "acme email required for first install"; exit 1; }
  sh ./scripts/gen-env.sh "$DOMAIN" "$EMAIL"
  set -a; . ./.env; set +a
else
  ok ".env exists, keeping secrets"
fi
grep -q '^TACTIC_MODE=' .env && sed -i "s/^TACTIC_MODE=.*/TACTIC_MODE=$MODE/" .env || echo "TACTIC_MODE=$MODE" >> .env
grep -q '^TACTIC_HTTP_PORT=' .env || echo "TACTIC_HTTP_PORT=$HTTP_PORT" >> .env

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  [ "$MODE" = standalone ] && { ufw allow 80,443/tcp >/dev/null; ufw allow 443/udp >/dev/null; }
  ok "ufw rules added"
fi

COMPOSE=(docker compose -f docker-compose.yml)
[ "$MODE" = proxy ] && COMPOSE+=(-f docker-compose.proxy.yml)
"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps

hdr "Health"
for i in $(seq 1 30); do
  if [ "$MODE" = proxy ]; then
    out="$(curl -fsS --max-time 3 -H "Host: $DOMAIN" "http://127.0.0.1:$HTTP_PORT/api/health" || true)"
  else
    out="$(curl -fsS --max-time 3 "https://$DOMAIN/api/health" || true)"
  fi
  [ -n "$out" ] && { ok "$out"; break; }
  sleep 4
done
[ -n "${out:-}" ] || warn "No healthy answer yet; see: ${COMPOSE[*]} logs --tail=100 caddy app"

echo
grn "Done. Admin panel: https://$DOMAIN -> Админ-панель, login $(grep '^ADMIN_USER=' .env | cut -d= -f2) / password in .env (ADMIN_PASSWORD)"
[ "$MODE" = proxy ] && yel "Remember to point the existing proxy at http://127.0.0.1:$HTTP_PORT for $DOMAIN."
exit 0
