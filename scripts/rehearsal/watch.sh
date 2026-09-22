#!/usr/bin/env bash
# Samples the update every 3s: run phase, pm2 states, and what the web port serves.
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null
B=http://127.0.0.1:8080
end=$(( $(date +%s) + 1200 ))
while [ "$(date +%s)" -lt "$end" ]; do
  st=$(node -e 'try{var s=JSON.parse(require("fs").readFileSync(process.env.HOME+"/canectic/logs/update/"+process.env.RUNID+".json","utf8"));var r=(s.phases||[]).filter(p=>p.status==="running")[0];console.log(s.status+" "+(r?r.name:"-")+" pid="+s.pid)}catch(e){console.log("no-run")}')
  pm=$(pm2 jlist 2>/dev/null | node -e 'try{var d=JSON.parse(require("fs").readFileSync(0));console.log(d.map(p=>p.name[0]+":"+p.pm2_env.status.substring(0,4)).join(","))}catch(e){console.log("pm2?")}')
  anon=$(curl -s -m 3 -o /tmp/w_anon -w "%{http_code}" $B/messages); ab=$(grep -qo "closed for maintenance" /tmp/w_anon && echo maint || echo -)
  sys=$(curl -s -m 3 -o /tmp/w_sys -w "%{http_code}" -b ~/rehearsal/cookies.txt $B/admin/update/progress); sb=$(grep -qo "served by the updater" /tmp/w_sys && echo updater || (grep -qo "served by the BBS" /tmp/w_sys && echo gateway || (grep -qo "closed for maintenance" /tmp/w_sys && echo maint || echo -)))
  flag=$([ -e ~/canectic/.maintenance ] && echo closed || echo open)
  echo "$(date +%H:%M:%S) run=[$st] pm2=[$pm] board=$flag anon=$anon/$ab sysop=$sys/$sb"
  case "$st" in complete*|failed*) sleep 12; echo "$(date +%H:%M:%S) final: board=$([ -e ~/canectic/.maintenance ] && echo closed || echo open)"; exit 0;; esac
  sleep 3
done
