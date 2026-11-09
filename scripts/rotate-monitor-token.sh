#!/usr/bin/env bash
# Rotasi token tulis monitor dev-workflow, dengan verifikasi.
#
# MENGAPA SKRIP INI ADA
# ---------------------
# Sebelum ini, mengganti token berarti menyunting empat tempat dengan tangan:
#   /etc/devwf-monitor.env di server  (yang MENENTUKAN token)
#   config OpenCode di HELLOWORLD, MMCH, dan Mac  (yang MENGIRIM token)
# Satu mesin yang terlewat tidak memunculkan error di layar - laporannya
# ditolak 401 dan kartunya menghilang diam-diam. Itu jenis kegagalan yang baru
# ketahuan berhari-hari kemudian.
#
# URUTAN YANG AMAN (tanpa downtime)
# ---------------------------------
#   1. Server diberi token BARU dulu, dan SEMENTARA menerima yang lama juga
#      (DEVWF_MONITOR_TOKEN_PREVIOUS) supaya mesin yang belum diperbarui
#      tidak langsung ditolak.
#   2. Setiap mesin pengirim diperbarui.
#   3. Token lama dicabut setelah semua mesin terbukti memakai yang baru.
#
# Skrip ini TIDAK PERNAH mencetak token. Tanpa --apply ia hanya melaporkan apa
# yang AKAN dilakukan.
set -uo pipefail

APPLY=0
MODE=""
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --revoke-previous) MODE="revoke" ;;
    *) echo "argumen tidak dikenal: $arg" >&2; exit 1 ;;
  esac
done
[ -n "$MODE" ] && APPLY=1

ENVF=/etc/devwf-monitor.env
SERVICE=devwf-monitor
STAMP=$(date +%Y%m%d-%H%M%S)

say() { echo "  $*"; }
step() { echo ""; echo "=== $* ==="; }

# Didefinisikan di awal karena dipakai juga oleh mode --revoke-previous.
kode() {
  curl -s -o /dev/null -w '%{http_code}' -m 6 \
    -X POST -H 'content-type: application/json' -H "authorization: Bearer $1" \
    -d "{\"sessionKey\":\"rotasi-uji\",\"machine\":\"server\",\"phase\":\"idle\",\"task\":\"\"}" \
    http://100.77.138.14:3100/api/session
}

if [ "$(id -u)" -ne 0 ]; then
  echo "Jalankan sebagai root." >&2
  exit 1
fi

step "0. keadaan sekarang"
if [ ! -f "$ENVF" ]; then
  echo "  GAGAL: $ENVF tidak ada" >&2
  exit 1
fi
perm=$(stat -c '%a' "$ENVF")
lama=$(grep -c '^DEVWF_MONITOR_TOKEN=' "$ENVF" || true)
say "berkas   : $ENVF (mode $perm)"
say "token    : $([ "$lama" -ge 1 ] && echo 'ADA' || echo 'TIDAK ADA')"
say "service  : $(systemctl is-active $SERVICE 2>/dev/null || echo '?')"
if [ "$perm" != "600" ]; then
  say "PERINGATAN: mode bukan 600"
fi

step "1. rencana"
say "buat token acak 40 karakter"
say "cadangkan $ENVF -> $ENVF.bak-$STAMP"
say "tulis token baru + simpan yang lama sebagai DEVWF_MONITOR_TOKEN_PREVIOUS"
say "restart $SERVICE, lalu uji: token baru diterima, token lama masih diterima"
say "sesudah semua mesin diperbarui, jalankan dengan --revoke-previous untuk mencabut yang lama"

if [ "$APPLY" -ne 1 ]; then
  step "MODE KERING"
  say "Tidak ada yang diubah. Jalankan dengan --apply untuk benar-benar melakukan."
  exit 0
fi

# Mode cabut: lewati pembuatan token baru, langsung ke pencabutan di akhir.
if [ "$MODE" = "revoke" ]; then
  step "cabut token lama"
  if ! grep -q '^DEVWF_MONITOR_TOKEN_PREVIOUS=' "$ENVF"; then
    say "tidak ada token lama yang tercatat - tidak ada yang dicabut"
    exit 0
  fi
  cp -p "$ENVF" "$ENVF.bak-revoke-$STAMP"
  BARU=$(grep '^DEVWF_MONITOR_TOKEN=' "$ENVF" | cut -d= -f2-)
  LAMA2=$(grep '^DEVWF_MONITOR_TOKEN_PREVIOUS=' "$ENVF" | cut -d= -f2-)
  grep -v '^DEVWF_MONITOR_TOKEN_PREVIOUS=' "$ENVF" > "$ENVF.new"
  chmod 600 "$ENVF.new"
  mv "$ENVF.new" "$ENVF"
  systemctl restart "$SERVICE"
  sleep 3
  say "service: $(systemctl is-active $SERVICE)"
  C_LAMA2=$(kode "$LAMA2")
  C_BARU2=$(kode "$BARU")
  say "POST token lama = $C_LAMA2  (harus 401 - sudah dicabut)"
  say "POST token baru = $C_BARU2  (harus 200)"
  sudo -u postgres psql -d devwf_monitor -tAc "DELETE FROM sessions WHERE session_key='rotasi-uji';" >/dev/null 2>&1
  say "cadangan: $ENVF.bak-revoke-$STAMP"
  exit 0
fi

if [ "$MODE" = "revoke" ]; then APPLY=1; fi

step "2. cadangan"
cp -p "$ENVF" "$ENVF.bak-$STAMP"
say "cadangan dibuat: $ENVF.bak-$STAMP"

step "3. token baru"
BARU=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
LAMA=$(grep '^DEVWF_MONITOR_TOKEN=' "$ENVF" | cut -d= -f2-)
{
  grep -v '^DEVWF_MONITOR_TOKEN=' "$ENVF" | grep -v '^DEVWF_MONITOR_TOKEN_PREVIOUS='
  printf 'DEVWF_MONITOR_TOKEN=%s\n' "$BARU"
  [ -n "$LAMA" ] && printf 'DEVWF_MONITOR_TOKEN_PREVIOUS=%s\n' "$LAMA"
} > "$ENVF.new"
chmod 600 "$ENVF.new"
mv "$ENVF.new" "$ENVF"
say "token baru ditulis (tidak dicetak), token lama disimpan sementara"
say "panjang token baru: ${#BARU} karakter"

step "4. restart dan uji"
systemctl restart "$SERVICE"
sleep 3
say "service: $(systemctl is-active $SERVICE)"


C_BARU=$(kode "$BARU")
C_LAMA=$(kode "$LAMA")
say "POST dengan token BARU = $C_BARU  (harus 200)"
say "POST dengan token LAMA = $C_LAMA  (200 = masih diterima, supaya mesin yang belum diperbarui tidak terputus)"

sudo -u postgres psql -d devwf_monitor -tAc "DELETE FROM sessions WHERE session_key='rotasi-uji';" >/dev/null 2>&1

step "5. yang harus dilakukan mesin pengirim"
cat <<EOF
  Token baru ada di $ENVF pada DEVWF_MONITOR_TOKEN.
  Perbarui DEVWF_MONITOR_TOKEN di config OpenCode SETIAP mesin:
    HELLOWORLD  ~/.config/opencode/opencode.json
    MMCH        %USERPROFILE%\\.config\\opencode\\opencode.json
    Mac         ~/.config/opencode/opencode.json
  Lalu restart OpenCode di masing-masing.

  Setelah semua mesin memakai token baru, cabut yang lama:
    $0 --revoke-previous
EOF

step "6. selesai"
say "cadangan: $ENVF.bak-$STAMP"
say "token TIDAK dicetak di mana pun oleh skrip ini"

# --- cabut token lama, hanya bila diminta ---
if [ "${1:-}" = "--revoke-previous" ]; then
  step "7. cabut token lama"
  if ! grep -q '^DEVWF_MONITOR_TOKEN_PREVIOUS=' "$ENVF"; then
    say "tidak ada token lama yang tercatat - tidak ada yang dicabut"
    exit 0
  fi
  LAMA2=$(grep '^DEVWF_MONITOR_TOKEN_PREVIOUS=' "$ENVF" | cut -d= -f2-)
  grep -v '^DEVWF_MONITOR_TOKEN_PREVIOUS=' "$ENVF" > "$ENVF.new"
  chmod 600 "$ENVF.new"
  mv "$ENVF.new" "$ENVF"
  systemctl restart "$SERVICE"
  sleep 3
  say "service: $(systemctl is-active $SERVICE)"
  C_LAMA2=$(kode "$LAMA2")
  C_BARU2=$(kode "$BARU")
  say "POST token lama = $C_LAMA2  (harus 401 - sudah dicabut)"
  say "POST token baru = $C_BARU2  (harus 200)"
  sudo -u postgres psql -d devwf_monitor -tAc "DELETE FROM sessions WHERE session_key='rotasi-uji';" >/dev/null 2>&1
fi
