#!/usr/bin/env sh
# Create or complete .env. Safe to re-run: a value that is already set is never
# changed; only missing secrets are added. Secrets go to .env only, never printed.
#
#   SESSION_SECRET     random, signs sessions and encrypts the token signing key
#   SETUP_TOKEN        random, the code the first-account page asks for
#   POSTGRES_PASSWORD  random (skipped when .env sets DATABASE_URL)
#
# Every other setting has a working default (docs/deploy.md).
set -eu
cd "$(dirname "$0")/.."

command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }
umask 077

# Random bytes as base64url (no +, / or newline), so values are safe in .env.
random_base64url() {
  openssl rand -base64 "$1" | tr -d '\n' | tr '+/' '-_'
}

# True when .env sets KEY to a non-empty value (optionally quoted or after "export").
has_value() {
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*([^[:space:]\"'#]|\"[^\"]|'[^'])" .env
}

# Put KEY=VALUE on the first empty "KEY=" line (or the "# KEY=" placeholder), else append it.
# The value goes through the environment, not the command line.
fill_value() {
  tmp=$(mktemp .env.XXXXXX)
  KEY="$1" VALUE="$2" awk '
    BEGIN { key = ENVIRON["KEY"]; empty = "^[ \t]*(export[ \t]+)?" key "[ \t]*=[ \t]*(\"\"|\047\047)?[ \t]*$" }
    !done && ($0 ~ empty || $0 == "# " key "=") { print key "=" ENVIRON["VALUE"]; done = 1; next }
    { print }
    END { if (!done) print key "=" ENVIRON["VALUE"] }
  ' .env >"$tmp"
  # Rewrite in place so the file keeps its permissions.
  cat "$tmp" >.env
  rm -f "$tmp"
}

if [ -e .env ]; then
  created=no
else
  cp .env.example .env
  chmod 600 .env
  created=yes
fi

added=""
if ! has_value SESSION_SECRET; then
  fill_value SESSION_SECRET "$(random_base64url 48)"
  added="$added SESSION_SECRET"
fi
if ! has_value SETUP_TOKEN; then
  fill_value SETUP_TOKEN "$(random_base64url 18)"
  added="$added SETUP_TOKEN"
fi
if ! has_value POSTGRES_PASSWORD && ! has_value DATABASE_URL; then
  fill_value POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  added="$added POSTGRES_PASSWORD"
fi

if [ "$created" = yes ]; then
  echo "Wrote .env with new random secrets:$added (permissions 600)."
elif [ -n "$added" ]; then
  echo ".env already existed. Added:$added. Other values were left alone."
else
  echo ".env already has every secret. Nothing changed."
fi
echo "The first-account page asks for SETUP_TOKEN (in .env; keep it secret)."
