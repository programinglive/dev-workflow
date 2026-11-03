#!/usr/bin/env bash
# Menampilkan tautan hidup yang tersisa, supaya bisa dibedakan: tautan
# sungguhan milik pemilik vs sisa probe pengujian.
set -uo pipefail
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1"; }
echo "== tautan hidup =="
Q "SELECT l.token || ' | sesi=' || l.session_key || ' | views=' || l.views || ' | dibuat=' || l.created_at::date
     FROM share_links l WHERE l.revoked_at IS NULL ORDER BY l.created_at DESC"
echo
echo "== yang sesinya sudah tidak ada (yatim) =="
Q "SELECT l.token FROM share_links l
    WHERE l.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_key = l.session_key)"
