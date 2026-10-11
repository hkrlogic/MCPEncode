#!/usr/bin/env sh
# Create .env from .env.example with fresh random secrets.
# Never overwrites an existing .env. Secrets are written to .env only, never printed.
set -eu
cd "$(dirname "$0")/.."

if [ -e .env ]; then
  echo ".env already exists. Leaving it alone." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }

umask 077
cp .env.example .env

set_value() {
  # Replace an empty KEY= line with KEY=<value>. Values are hex/base64url, safe for sed.
  sed -i.bak "s|^$1=\$|$1=$2|" .env && rm -f .env.bak
}

set_value SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n' | tr '+/' '-_')"
set_value POSTGRES_PASSWORD "$(openssl rand -hex 24)"

echo "Wrote .env with new random secrets (permissions 600)."
