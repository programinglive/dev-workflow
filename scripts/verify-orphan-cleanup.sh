#!/usr/bin/env bash
# Membuktikan aksi "cabut yang yatim": hanya tautan tanpa sesi yang kena,
# sesi idle tidak tersentuh, dan endpoint-nya tetap terlindungi guard.
set -euo pipefail
BASE=http://100.77.138.14:3100
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1"; }

HIDUP="ses_uji_bersih_hidup_$(date +%s)"
IDLE="ses_uji_bersih_idle_$(date +%s)"
YATIM="ses_uji_bersih_yatim_$(date +%s)"
TH=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")
TI=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")
TY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")

Q "INSERT INTO sessions (session_key, machine, task, phase, updated_at) VALUES ('$HIDUP','uji','sesi aktif','coding', now());" >/dev/null
Q "INSERT INTO sessions (session_key, machine, task, phase, updated_at) VALUES ('$IDLE','uji','sesi idle lama','idle', now() - interval '3 hours');" >/dev/null
Q "INSERT INTO share_links (token, session_key) VALUES ('$TH','$HIDUP'),('$TI','$IDLE'),('$TY','$YATIM');" >/dev/null

echo "dibuat 3 tautan: aktif, idle-3-jam, yatim"

echo "--- guard: tanpa header harus 403 ---"
curl -sS -o /dev/null -w "  status=%{http_code}\n" -X POST "$BASE/api/share?revoke-orphans=1"

echo "--- cabut yang yatim ---"
curl -sS -X POST "$BASE/api/share?revoke-orphans=1" -H 'x-devwf-share: 1'
echo

echo "--- hasil per tautan ---"
Q "SELECT session_key || ' -> ' || CASE WHEN revoked_at IS NULL THEN 'MASIH HIDUP' ELSE 'dicabut' END
     FROM share_links WHERE session_key LIKE 'ses_uji_bersih_%' ORDER BY session_key"

echo "--- bersih-bersih ---"
Q "DELETE FROM share_links WHERE session_key LIKE 'ses_uji_bersih_%';" >/dev/null
Q "DELETE FROM sessions WHERE session_key LIKE 'ses_uji_bersih_%';" >/dev/null
echo "selesai"
