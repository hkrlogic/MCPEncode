#!/usr/bin/env bash
# Copy Source Sans 3 and Source Serif 4 (SIL Open Font License) into public/fonts so the
# app serves its own fonts. Run once, then commit public/fonts. Needs npm and network.
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/fonts
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"
for pkg in source-sans-3 source-serif-4; do
  (cd "$tmp" && npm pack "@fontsource-variable/$pkg" --silent >/dev/null && tar -xzf ./*"$pkg"*.tgz && rm -rf "pkg-$pkg" && mv package "pkg-$pkg" && rm -f ./*.tgz)
  cp "$tmp/pkg-$pkg/files/$pkg-latin-wght-normal.woff2" "$out/"
  cp "$tmp/pkg-$pkg/LICENSE" "$out/LICENSE-$pkg.txt"
done
echo "Fonts written to $out. Commit them."
ls -l "$out"
