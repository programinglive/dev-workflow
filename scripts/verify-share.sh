#!/usr/bin/env bash
# Membuat tautan share untuk sesi pertama yang sedang hidup, lalu mencetak
# tokennya. Dipakai untuk verifikasi manual di server.
set -euo pipefail
curl -sS http://100.77.138.14:3100/api/sessions -o /tmp/sesi.json
node -e '
const j = JSON.parse(require("fs").readFileSync("/tmp/sesi.json", "utf8"));
console.log("sesi:", j.sessions.length, "share:", (j.shares || []).length);
for (const s of j.sessions.slice(0, 5)) {
  console.log("  " + s.session_key + " | " + String(s.task || "-").slice(0, 50));
}
'
KEY=$(node -e '
const j = JSON.parse(require("fs").readFileSync("/tmp/sesi.json", "utf8"));
const s = j.sessions[0];
console.log(s ? s.session_key : "");
')
if [ -z "$KEY" ]; then echo "TIDAK ADA SESI untuk dibagikan"; exit 2; fi
echo "membuat tautan untuk: $KEY"
curl -sS -X POST http://100.77.138.14:3100/api/share \
  -H 'content-type: application/json' -H 'x-devwf-share: 1' \
  -d "{\"sessionKey\":\"$KEY\"}" | tee /tmp/share.json
echo
