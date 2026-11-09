#!/usr/bin/env bash
# Body rusak pada endpoint tulis: dengan token yang SAH, harus 400 (bukan 500).
set -uo pipefail
BASE=http://100.77.138.14:3100
TOK=$(grep '^DEVWF_MONITOR_TOKEN=' /etc/devwf-monitor.env | cut -d= -f2-)

echo "token terbaca: $([ -n "$TOK" ] && echo ya || echo TIDAK)"
for ep in "/api/session" "/api/event"; do
  S=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE$ep" \
        -H 'content-type: application/json' \
        -H "authorization: Bearer $TOK" -d '{bad}')
  echo "  $ep + token sah + body rusak -> $S (harus 400)"
done

echo "--- kontrol: body SAH harus tetap diterima ---"
curl -sS -o /dev/null -w '  /api/event body sah -> %{http_code}\n' -X POST "$BASE/api/event" \
  -H 'content-type: application/json' -H "authorization: Bearer $TOK" \
  -d '{"sessionKey":"ses_uji_parse","kind":"uji_parse","detail":"kontrol"}'
