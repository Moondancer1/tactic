#!/usr/bin/env sh
# Generate .env with random secrets. Usage: ./scripts/gen-env.sh tactic.example.com admin@example.com
set -eu

DOMAIN="${1:?usage: gen-env.sh <domain> <acme-email>}"
EMAIL="${2:?usage: gen-env.sh <domain> <acme-email>}"
PUBLIC_IP="$(curl -4 -fsS https://api.ipify.org || echo 0.0.0.0)"

if [ -f .env ]; then
  echo ".env already exists, refusing to overwrite" >&2
  exit 1
fi

rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cat > .env <<EOF
DOMAIN=${DOMAIN}
ACME_EMAIL=${EMAIL}
PUBLIC_IP=${PUBLIC_IP}
JWT_SECRET=$(rnd 32)
ADMIN_USER=administrator
ADMIN_PASSWORD=$(rnd 8)
ADMIN_TOKEN=$(rnd 24)
LIVEKIT_API_KEY=tactic
LIVEKIT_API_SECRET=$(rnd 32)
TURN_USER=tactic
TURN_PASSWORD=$(rnd 16)
CORS_ORIGINS=
RETENTION_DAYS=30
EOF

chmod 600 .env
echo "Wrote .env (PUBLIC_IP=${PUBLIC_IP}). ADMIN_TOKEN:"
grep '^ADMIN_TOKEN=' .env | cut -d= -f2
