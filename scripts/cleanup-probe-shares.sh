#!/usr/bin/env bash
# Mencabut tautan SISA PROBE yang saya buat selama pengujian 3 November 2026.
#
# Hanya token yang saya catat sendiri yang disentuh. Tautan yang tidak saya
# buat TIDAK dikenali di sini dan TIDAK pernah dicabut oleh skrip ini - supaya
# tidak ada tautan pemilik yang mati karena "bersih-bersih" otomatis.
set -euo pipefail
Q() { sudo -u postgres psql -d devwf_monitor -tAc "$1" | tr -d ' '; }

TOKENS=(
  "0356tg8f1kGF9B0Cj_SLZrzMYA9M1khGOlMt68L-TPA"
  "c8ZQA6-OD32F1jcGvEETboxFg4XJTwUsIos9JJicRLE"
  "h-rvtG7VLYUrwMFEgThuLL6JZKBYkeVXd8rKcvYSdsw"
)

echo "== sebelum =="
echo "  hidup: $(Q "SELECT count(*) FROM share_links WHERE revoked_at IS NULL")"
echo "  total: $(Q "SELECT count(*) FROM share_links")"

for t in "${TOKENS[@]}"; do
  n=$(Q "SELECT count(*) FROM share_links WHERE token='$t'")
  if [ "$n" = "1" ]; then
    Q "UPDATE share_links SET revoked_at=now() WHERE token='$t' AND revoked_at IS NULL;" >/dev/null
    echo "  dicabut: ${t:0:12}..."
  else
    echo "  dilewati (tidak ada): ${t:0:12}..."
  fi
done

echo "== sesudah =="
echo "  hidup: $(Q "SELECT count(*) FROM share_links WHERE revoked_at IS NULL")"
echo "  total: $(Q "SELECT count(*) FROM share_links")  (baris tidak dihapus, hanya dicabut)"
