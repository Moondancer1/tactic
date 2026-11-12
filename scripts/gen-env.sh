#!/usr/bin/env sh
# Generate .env with random secrets. Usage: ./scripts/gen-env.sh tactic.example.com admin@example.com
set -eu

DOMAIN="${1:?usage: gen-env.sh <domain> <acme-email>}"
EMAIL="${2:?usage: gen-env.sh <domain> <acme-email>}"

if [ -f .env ]; then
  echo ".env already exists, refusing to overwrite" >&2
  exit 1
fi

rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cat > .env <<EOF
DOMAIN=${DOMAIN}
ACME_EMAIL=${EMAIL}
JWT_SECRET=$(rnd 32)
ADMIN_USER=administrator
ADMIN_PASSWORD=$(rnd 12)
ADMIN_TOKEN=$(rnd 24)
CORS_ORIGINS=
RETENTION_DAYS=30
EOF

chmod 600 .env
echo "Wrote .env. Admin panel login:"
grep -E '^ADMIN_(USER|PASSWORD)=' .env
