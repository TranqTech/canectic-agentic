#!/usr/bin/env bash
# One rehearsal pass: install FROM_VERSION from ~/rehearsal/releases, register the sysop,
# point the update check at the local server, connect a terminal caller and a browser-like
# client, press Update to TO_VERSION from the Admin UI, and start watch.sh on the run.
# The board must already be reset (reset.sh).
#
#   bash pass.sh <from> <to> [stable|development]
#   BOOTSTRAP=~/rehearsal/bootstrap.sh bash pass.sh ...   an older bootstrap, for a withdrawn
#                                                        <from> the current one refuses
#   SKIP_INSTALL=1 bash pass.sh ...                      the board is already installed
#
# Results: watch-<from>.log, caller.log, webtab.log, and the run's own log under
# ~/canectic/logs/update/. See "Rehearsing a release" in docs/reference/RELEASE_PROCESS.md.
set -euo pipefail
FROM_VERSION="$1"; TO_VERSION="$2"; CHANNEL="${3:-stable}"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null
cd ~/rehearsal; umask 077
if [ -z "${SKIP_INSTALL:-}" ]; then
bash ${BOOTSTRAP:-releases/bootstrap.sh} --from ~/rehearsal/releases --version "$FROM_VERSION" --target ~/canectic \
  --db-pass "$(cat ~/.canectic-dbpass)" > "install-$FROM_VERSION.log" 2>&1 < /dev/null || true
fi
sed -e 's/\x1b\[[0-9;]*m//g' "install-$FROM_VERSION.log" | grep -E "signature|verify|installed|did not finish" | head -5
if ! pgrep -f "[h]ttp.server 18181" >/dev/null; then nohup python3 -m http.server 18181 --bind 127.0.0.1 --directory "$HOME/rehearsal/releases" > http.log 2>&1 < /dev/null & fi
[ -s ~/.canectic-sysop ] || openssl rand -hex 12 > ~/.canectic-sysop
PW=$(cat ~/.canectic-sysop); B=http://127.0.0.1:8080
for i in $(seq 1 120); do curl -s -o /dev/null -m 2 $B/ && break; sleep 1; done
curl -s -o reg.html -w "register -> %{http_code}\n" -H "Origin: $B" -c cookies.txt -b cookies.txt \
  --data-urlencode "age_verified=yes" --data-urlencode "username=RehearsalSysop" --data-urlencode "password=$PW" \
  --data-urlencode "password_confirm=$PW" --data-urlencode "firstname=Rehearsal" --data-urlencode "lastname=Sysop" \
  --data-urlencode "mailaddress=rehearsal@example.invalid" --data-urlencode "gender=Undisclosed" --data-urlencode "birthdate=1980-01-01" $B/users/register
curl -s -o /dev/null -w "login -> %{http_code}\n" -H "Origin: $B" -c cookies.txt -b cookies.txt --data-urlencode "username=RehearsalSysop" --data-urlencode "password=$PW" $B/users/login
export PGPASSWORD=$(cat ~/.canectic-dbpass)
psql -h localhost -U canectic -d canectic_bbs -q -c "UPDATE settings SET value='$CHANNEL', source='sysop' WHERE key='update_channel'; UPDATE settings SET value='http://127.0.0.1:18181/', source='sysop' WHERE key='update_check_url';"
curl -s -o /dev/null -w "reload -> %{http_code}\n" -H "Origin: $B" -b cookies.txt -X POST $B/admin/config/reload
sleep 2
curl -s -o /dev/null -w "check -> %{http_code}\n" -H "Origin: $B" -b cookies.txt -X POST $B/admin/update/check
curl -s -b cookies.txt $B/admin/update > update.html
grep -oE 'name="version" value="[^"]*"|Nothing blocking|Blocked[^<]*' update.html | sort -u || true
# The Update button needs the upgrade notes acknowledged after 0.9.10a (#55);
# send the token the page shows, as ticking the box does. Empty for older pages.
ACK=$(grep -oE 'name="ack" value="[^"]*"' update.html | head -1 | sed -e 's/.*value="//' -e 's/"$//' || true)
[ -n "$ACK" ] && echo "upgrade notes acknowledged ($ACK)"
# No panel on a page from before 0.9.11a; under pipefail an empty grep would end the pass here.
grep -oE 'Before you update to [^<]*|could not be verified[^<]*' update.html | head -2 || true
rm -f caller.log webtab.log
pkill -f "[w]ebtab.mjs" || true
nohup node caller.mjs > /dev/null 2>&1 < /dev/null &
nohup node webtab.mjs > /dev/null 2>&1 < /dev/null &
sleep 3
before=$(ls ~/canectic/logs/update/*.json 2>/dev/null | grep -v latest | wc -l)
curl -s -o apply.html -w "apply -> %{http_code} %{redirect_url}\n" -H "Origin: $B" -b cookies.txt --data-urlencode "version=$TO_VERSION" --data-urlencode "ack=$ACK" $B/admin/update/apply
for i in $(seq 1 40); do n=$(ls ~/canectic/logs/update/*.json 2>/dev/null | grep -v latest | wc -l); [ "$n" -gt "$before" ] && break; sleep 0.5; done
RUNID=$(ls -t ~/canectic/logs/update/*.json | grep -v latest | head -1 | xargs basename | sed 's/\.json$//')
echo "RUNID=$RUNID"; echo "$RUNID" > current-run
RUNID=$RUNID nohup bash watch.sh > "watch-$FROM_VERSION.log" 2>&1 < /dev/null &
