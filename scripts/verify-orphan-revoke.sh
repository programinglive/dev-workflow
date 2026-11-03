#!/usr/bin/env bash
# Membuktikan tautan yang sesinya sudah hilang TETAP bisa dicabut.
#
# Membuat satu baris share_links untuk session_key yang tidak ada di tabel
# sessions - persis keadaan tautan yang ditinggal retensi - lalu memastikan
# (1) ia muncul di panel, (2) ia masih bisa dicabut, (3) URL-nya jadi 410.
set -euo pipefail

TOKEN="ORPHANTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
KEY="ses_orphan_uji_$(date +%s)"

sudo -u postgres psql -d devwf_monitor -tAc \
  "INSERT INTO share_links (token, session_key) VALUES ('$TOKEN', '$KEY');" >/dev/null

echo "dibuat: token=${TOKEN:0:10}... untuk sesi $KEY (tidak ada di tabel sessions)"

echo "--- 1. muncul di panel? ---"
curl -sS -H 'x-devwf-share: 1' 'http://100.107.65.21:3100/api/share?all=1' \
  | grep -o "\"token\":\"$TOKEN\"" && echo "YA: tautan yatim terlihat di panel"

echo "--- 2. sesi benar-benar tidak ada? ---"
N=$(sudo -u postgres psql -d devwf_monitor -tAc "SELECT count(*) FROM sessions WHERE session_key='$KEY';" | tr -d ' ')
echo "baris sessions: $N (harus 0)"

echo "--- 3. bisa dicabut? ---"
curl -sS -X DELETE "http://100.107.65.21:3100/api/share?token=$TOKEN" -H 'x-devwf-share: 1'
echo

echo "--- 4. URL jadi 410? ---"
curl -sS -o /dev/null -w "status=%{http_code}\n" "https://devwfshare.programinglive.com/s/$TOKEN"

echo "--- 5. bersih-bersih ---"
sudo -u postgres psql -d devwf_monitor -tAc \
  "DELETE FROM share_links WHERE session_key='$KEY';" >/dev/null
echo "baris uji dihapus"
