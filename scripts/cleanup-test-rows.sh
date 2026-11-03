#!/usr/bin/env bash
# Membersihkan baris uji yang dibuat probe-json400.sh, lalu membuktikan bersih.
set -euo pipefail
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1" | tr -d ' '; }
echo "sebelum: $(Q "SELECT count(*) FROM events WHERE session_key LIKE 'ses_uji%'")"
Q "DELETE FROM events WHERE session_key LIKE 'ses_uji%';" >/dev/null
echo "sesudah: $(Q "SELECT count(*) FROM events WHERE session_key LIKE 'ses_uji%'")"
echo "sisa share_links uji: $(Q "SELECT count(*) FROM share_links WHERE session_key LIKE 'ses_uji%' OR session_key LIKE 'ses_share_uji%'")"
echo "sisa sessions uji:    $(Q "SELECT count(*) FROM sessions WHERE session_key LIKE 'ses_uji%' OR session_key LIKE 'ses_share_uji%'")"
