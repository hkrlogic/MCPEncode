#!/usr/bin/env sh
# Create .env from .env.example with fresh random secrets.
# Run again on an existing .env to add a SETUP_TOKEN if it has none. A value that
# is already set is never changed. Secrets are written to .env only, never printed.
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
  if has_value SETUP_TOKEN; then
    echo ".env already exists and has a SETUP_TOKEN. Nothing changed."
  else
    fill_value SETUP_TOKEN "$(random_base64url 18)"
    echo ".env already exists. Added a random SETUP_TOKEN; other values were left alone."
  fi
else
  cp .env.example .env
  fill_value SESSION_SECRET "$(random_base64url 48)"
  fill_value POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  fill_value SETUP_TOKEN "$(random_base64url 18)"
  echo "Wrote .env with new random secrets (permissions 600)."
fi

echo "Reminder: every public deploy needs a SETUP_TOKEN (it is in .env; keep it secret). The first-account page asks for it."
