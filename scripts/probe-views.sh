#!/usr/bin/env bash
# Verifikasi perbaikan audit: views hanya dari GET, JSON rusak menjawab 400
# di SEMUA endpoint tulis (bukan hanya /api/share).
set -uo pipefail
BASE=http://100.107.65.21:3100
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1" | tr -d ' '; }
TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")
KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(35).toString('base64url'))")

Q "INSERT INTO sessions (session_key, machine, task, phase, updated_at) VALUES ('$KEY','uji','uji views','coding', now());" >/dev/null
Q "INSERT INTO share_links (token, session_key) VALUES ('$TOKEN','$KEY');" >/dev/null

echo "== views: GET vs HEAD =="
echo "  awal: $(Q "SELECT views FROM share_links WHERE token='$TOKEN'")"
for i in 1 2 3; do curl -sS -o /dev/null "https://devwfshare.programinglive.com/s/$TOKEN"; done
sleep 2
echo "  sesudah 3 GET: $(Q "SELECT views FROM share_links WHERE token='$TOKEN'")  (harus 3)"
for i in 1 2; do curl -sS -o /dev/null -I "https://devwfshare.programinglive.com/s/$TOKEN"; done
sleep 2
V=$(Q "SELECT views FROM share_links WHERE token='$TOKEN'")
echo "  sesudah 2 HEAD: $V  (harus TETAP 3)"
if [ "$V" != "3" ]; then echo "  GAGAL: HEAD ikut dihitung"; else echo "  LULUS"; fi

echo
echo "== body JSON rusak di endpoint tulis =="
for ep in "/api/share" "/api/session" "/api/event"; do
  S=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE$ep" \
        -H 'content-type: application/json' -H 'x-devwf-share: 1' \
        -H 'authorization: Bearer x' -d '{bad}')
  echo "  $ep -> $S (harus 400)"
done

Q "DELETE FROM share_links WHERE token='$TOKEN';" >/dev/null
Q "DELETE FROM sessions WHERE session_key='$KEY';" >/dev/null
echo
echo "data uji dihapus"
