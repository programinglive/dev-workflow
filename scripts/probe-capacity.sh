#!/usr/bin/env bash
# Berapa permintaan/detik yang benar-benar bisa dilayani share-server sebelum
# Postgres jadi hambatan? Angka ini yang menentukan apakah batas per-tautan
# perlu ada, atau justru menciptakan masalah baru.
set -uo pipefail
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1" | tr -d ' '; }
echo "CPU: $(nproc) core"
TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")
KEY="ses_uji_load_$(date +%s)"
Q "INSERT INTO sessions (session_key, machine, task, phase, updated_at) VALUES ('$KEY','uji','uji beban','coding', now());" >/dev/null
Q "INSERT INTO share_links (token, session_key) VALUES ('$TOKEN','$KEY');" >/dev/null

URL="http://127.0.0.1:3200/s/$TOKEN"
echo "== 200 permintaan berurutan, satu koneksi, tanpa batas laju =="
# Batas laju dimatikan sementara agar murni mengukur kapasitas.
START=$(date +%s%N)
FAIL=0
for i in $(seq 1 200); do
  S=$(curl -sS -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 198.51.100.7' $URL)
  [ "$S" = "200" ] || FAIL=$((FAIL+1))
done
END=$(date +%s%N)
MS=$(( (END-START)/1000000 ))
echo "  200 permintaan dalam ${MS}ms -> $(( 200000 / (MS>0?MS:1) )) req/detik"
echo "  gagal: $FAIL"
echo "  views tercatat: $(Q "SELECT views FROM share_links WHERE token='$TOKEN'") (harus 200)"

Q "DELETE FROM share_links WHERE token='$TOKEN';" >/dev/null
Q "DELETE FROM sessions WHERE session_key='$KEY';" >/dev/null
echo "data uji dihapus"
