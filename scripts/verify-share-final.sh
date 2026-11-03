#!/usr/bin/env bash
# Verifikasi akhir: semua jalur share hidup, tidak ada sisa data uji,
# dan guard masih menolak yang seharusnya ditolak.
set -uo pipefail
BASE=http://100.107.65.21:3100
PUB=https://devwfshare.programinglive.com
MAIN=https://devworkflow.programinglive.com
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1"; }
gagal=0
cek() { # cek <nama> <harapan> <dapat>
  if [ "$2" = "$3" ]; then echo "  OK   $1 ($3)"; else echo "  GAGAL $1: harap $2, dapat $3"; gagal=$((gagal+1)); fi
}

echo "== 1. service =="
for s in devwf-monitor devwf-share cloudflared-devwf-share; do
  cek "$s" active "$(systemctl is-active $s)"
done

echo "== 2. health =="
cek "share /health" 200 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' $PUB/health)"
cek "dashboard /health" 200 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' $BASE/health)"

echo "== 3. guard =="
cek "POST /api/share tanpa header" 403 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST $BASE/api/share -H 'content-type: application/json' -d '{}')"
cek "GET ?all=1 tanpa header" 403 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/share?all=1")"
cek "OPTIONS origin asing" 403 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X OPTIONS $BASE/api/share -H 'x-devwf-share: 1' -H 'origin: https://evil.example')"
cek "OPTIONS origin sah" 204 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X OPTIONS $BASE/api/share -H 'x-devwf-share: 1' -H 'origin: http://100.107.65.21:3100')"
cek "body JSON rusak" 400 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST $BASE/api/share -H 'content-type: application/json' -H 'x-devwf-share: 1' -d '{bad}')"

echo "== 4. port publik tidak bisa menulis =="
TOK=$(node -e "process.stdout.write('X'.repeat(43))")
for m in POST PUT DELETE; do
  cek "$m /s/<token>" 405 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X $m $PUB/s/$TOK)"
done

echo "== 5. token tidak dikenal =="
cek "GET /s/<token asing>" 404 "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' $PUB/s/$TOK)"

echo "== 6. domain utama mem-proxy =="
cek "GET /share/ (halaman statis)" 200 "$(curl -sS -m 15 -o /dev/null -w '%{http_code}' $MAIN/share/)"
cek "GET /s/<token asing> lewat domain utama" 404 "$(curl -sS -m 15 -o /dev/null -w '%{http_code}' $MAIN/s/$TOK)"

echo "== 7. tidak ada sisa data uji =="
cek "share_links sisa uji" 0 "$(Q "SELECT count(*) FROM share_links WHERE session_key LIKE 'ses_uji%' OR session_key LIKE 'ses_share_uji%' OR token LIKE 'ORPHANTEST%'" | tr -d ' ')"
cek "sessions sisa uji" 0 "$(Q "SELECT count(*) FROM sessions WHERE session_key LIKE 'ses_uji%' OR session_key LIKE 'ses_share_uji%'" | tr -d ' ')"

echo "== 8. isi tabel share =="
echo "  hidup: $(Q 'SELECT count(*) FROM share_links WHERE revoked_at IS NULL' | tr -d ' ') | total: $(Q 'SELECT count(*) FROM share_links' | tr -d ' ')"

echo
if [ $gagal -eq 0 ]; then echo "SEMUA LULUS"; else echo "$gagal PEMERIKSAAN GAGAL"; exit 1; fi