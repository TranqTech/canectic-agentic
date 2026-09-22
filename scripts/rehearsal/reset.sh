#!/usr/bin/env bash
# Resets the rehearsal board: stops and forgets its pm2 apps, removes the install,
# drops and recreates the database. Reads the sudo password from stdin.
set -euo pipefail
IFS= read -r SUDOPW
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null
pm2 delete all >/dev/null 2>&1 || true
pm2 save --force >/dev/null 2>&1 || true
pkill -f "http.server 18181" || true
rm -rf "$HOME/canectic"
printf '%s\n' "$SUDOPW" | sudo -S -p '' -v
sudo -u postgres dropdb --if-exists canectic_bbs
printf '%s\n' "$SUDOPW" | bash "$HOME/rehearsal/mkdb.sh"
rm -f "$HOME/rehearsal/cookies.txt" "$HOME/.canectic-sysop"
echo "reset done; pm2 apps: $(pm2 jlist 2>/dev/null | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).length)')"
