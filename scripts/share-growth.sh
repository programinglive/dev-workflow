#!/usr/bin/env bash
# Melihat seberapa cepat share_links tumbuh, supaya keputusan retensi dibuat
# dari angka, bukan dugaan.
set -euo pipefail
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1"; }

echo "hidup (belum dicabut): $(Q 'SELECT count(*) FROM share_links WHERE revoked_at IS NULL')"
echo "total baris          : $(Q 'SELECT count(*) FROM share_links')"
echo "tautan paling tua    : $(Q 'SELECT min(created_at)::date FROM share_links')"
echo "baris per tanggal:"
Q "SELECT created_at::date, count(*) FROM share_links GROUP BY created_at::date ORDER BY created_at::date"
echo
echo "sesi yang punya tautan hidup tapi sudah tidak tampil di dashboard:"
Q "SELECT l.session_key || ' | dibuat ' || l.created_at::date
     FROM share_links l
     LEFT JOIN sessions s ON s.session_key = l.session_key
    WHERE l.revoked_at IS NULL
      AND (s.session_key IS NULL OR s.updated_at < now() - interval '30 minutes')"
