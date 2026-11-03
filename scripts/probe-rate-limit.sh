#!/usr/bin/env bash
# Mengukur pembatas laju LANGSUNG ke share-server (127.0.0.1:3200), bukan lewat
# Cloudflare.
#
# MENGAPA: lewat Cloudflare, header CF-Connecting-IP yang saya karang DITIMPA
# oleh Cloudflare, bahkan dijawab 403 oleh WAF-nya. Hasilnya dulu tampak
# "lulus" padahal yang menjawab adalah Cloudflare, bukan server kita.
set -uo pipefail
URL=http://127.0.0.1:3200/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

echo "== A. satu pembaca (IP sama), 130 permintaan =="
OK=0; TOO=0
for i in $(seq 1 130); do
  S=$(curl -sS -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 198.51.100.200' $URL)
  if [ "$S" = "429" ]; then TOO=$((TOO+1)); else OK=$((OK+1)); fi
done
echo "   dilayani=$OK  429=$TOO"
if [ "$TOO" -eq 0 ]; then echo "   -> pembatas TIDAK bekerja (seharusnya ada 429)"; exit 1; fi

echo "== B. pembaca BERBEDA sesudahnya =="
BLOK=0
for i in $(seq 1 12); do
  S=$(curl -sS -o /dev/null -w '%{http_code}' -H "CF-Connecting-IP: 203.0.113.$i" $URL)
  if [ "$S" = "429" ]; then BLOK=$((BLOK+1)); fi
  printf '%s ' "$S"
done
echo
if [ "$BLOK" -eq 0 ]; then
  echo "   -> LULUS: pembaca lain TIDAK terblokir oleh pembaca pertama"
else
  echo "   -> GAGAL: $BLOK pembaca lain ikut terblokir"
  exit 1
fi
