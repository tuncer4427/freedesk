#!/usr/bin/env bash
# Regenerates install-server.sh with the current server files embedded.
set -euo pipefail
cd "$(dirname "$0")"
embed() {
  printf "cat > \"\$BASE/server/%s\" <<'FREEDESK_EOF_%s'\n" "$1" "$2"
  cat "$1"
  printf "FREEDESK_EOF_%s\n" "$2"
}
{
  cat install-server.sh.head
  embed package.json PKG
  embed package-lock.json LOCK
  embed server.js SRV
  cat install-server.sh.tail
} > install-server.sh
chmod +x install-server.sh
bash -n install-server.sh
