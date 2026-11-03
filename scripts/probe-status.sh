#!/usr/bin/env bash
# Apakah kegagalan itu BATAS LAJU (429) atau kesalahan sungguhan (5xx)?
# Bedanya menentukan: 429 = desain, 5xx = bug.
set -uo pipefail
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1" | tr -d ' '; }
TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")
KEY="ses_uji_diag_$(date +%s)"
Q "INSERT INTO sessions (session_key, machine, task, phase, updated_at) VALUES ('$KEY','uji','diag','coding', now());" >/dev/null
Q "INSERT INTO share_links (token, session_key) VALUES ('$TOKEN','$KEY');" >/dev/null

echo "== rincian status 200 permintaan =="
declare -A N
for i in $(seq 1 200); do
  S=$(curl -sS -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 198.51.100.7' "http://127.0.0.1:3200/s/$TOKEN")
  N[$S]=$(( ${N[$S]:-0} + 1 ))
done
for k in "${!N[@]}"; do echo "  HTTP $k : ${N[$k]}"; done

echo "== ulangi dengan 120 permintaan (di bawah batas) =="
declare -A M
for i in $(seq 1 120); do
  S=$(curl -sS -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 198.51.100.8' "http://127.0.0.1:3200/s/$TOKEN")
  M[$S]=$(( ${M[$S]:-0} + 1 ))
done
for k in "${!M[@]}"; do echo "  HTTP $k : ${M[$k]}"; done
echo "  views total sekarang: $(Q "SELECT views FROM share_links WHERE token='$TOKEN'") (200 + 120 = 320 kalau semua dihitung)"

Q "DELETE FROM share_links WHERE token='$TOKEN';" >/dev/null
Q "DELETE FROM sessions WHERE session_key='$KEY';" >/dev/null
