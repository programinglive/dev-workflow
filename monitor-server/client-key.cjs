'use strict';

/**
 * Kunci pembatas laju: siapa sebenarnya pembaca ini?
 *
 * MASALAH YANG DITUTUP (3 November 2026, terukur di produksi)
 * ----------------------------------------------------------
 * `req.socket.remoteAddress` SELALU `127.0.0.1` di balik Cloudflare Tunnel:
 * yang tersambung ke share-server adalah cloudflared di mesin yang sama, bukan
 * pembaca. Akibatnya pembatas laju memperlakukan semua pembaca sebagai satu
 * orang. Diukur: 130 permintaan berurutan → 11 dijawab 429.
 *
 * Artinya siapa pun yang membuka satu tautan 120 kali dalam semenit memblokir
 * SEMUA pembaca lain, termasuk pemilik tautannya. Satu crawler preview
 * WhatsApp pun cukup.
 *
 * MENGAPA HEADER TIDAK DIPERCAYA BEGITU SAJA
 * ------------------------------------------
 * `CF-Connecting-IP` bisa dipalsukan oleh siapa pun yang bisa menjangkau port
 * 3200 langsung. Karena share-server bind ke 127.0.0.1, satu-satunya yang
 * boleh mengirim header itu adalah proxy di mesin yang sama. Jadi header
 * HANYA dibaca bila koneksinya datang dari loopback; dari alamat lain,
 * header diabaikan dan alamat soket yang dipakai.
 *
 * Berkas ini tidak membuka socket; ia hanya memutuskan sebuah string.
 */

/** Apakah koneksi ini datang dari mesin yang sama (proxy lokal)? */
function isLoopback(alamat) {
  const a = String(alamat || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** IPv4 sederhana: empat oktet 0-255. */
function isIpv4(v) {
  const bagian = v.split('.');
  if (bagian.length !== 4) return false;
  return bagian.every((b) => {
    if (!/^\d{1,3}$/.test(b)) return false;
    const n = Number(b);
    return n >= 0 && n <= 255 && String(n) === b.replace(/^0+(?=\d)/, '');
  });
}

/**
 * IPv6 secukupnya: heksadesimal dan titik dua, dengan `::` untuk pemendekan.
 * Validasi panjang penuh tidak diperlukan di sini - yang penting nilainya
 * tidak bisa dipakai menumbuhkan peta pembatas laju tanpa batas.
 */
function isIpv6(v) {
  if (!/^[0-9a-fA-F:.]+$/.test(v)) return false;
  if (!v.includes(':')) return false;
  if ((v.match(/::/g) || []).length > 1) return false;
  const grup = v.split(':').filter((g) => g !== '');
  if (grup.length > 8) return false;
  return grup.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g) || (g.includes('.') && isIpv4(g)));
}

function isValidIp(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return false;
  return isIpv4(s) || isIpv6(s);
}

/**
 * @param {{remoteAddress?: string, headers?: object}} args
 * @returns {string} kunci stabil untuk pembatas laju
 */
function clientKey({ remoteAddress, headers } = {}) {
  const socket = String(remoteAddress || '');
  const h = headers || {};

  // Header hanya bermakna bila pengirimnya proxy lokal.
  if (isLoopback(socket)) {
    const mentah = h['cf-connecting-ip'];
    const nilai = Array.isArray(mentah) ? mentah[0] : mentah;
    if (typeof nilai === 'string') {
      // Cloudflare kadang mengirim daftar; ambil elemen pertama yang sah.
      const pertama = nilai.split(',')[0].trim();
      if (isValidIp(pertama)) return pertama;
    }
  }

  return socket || 'unknown';
}

module.exports = { clientKey, isValidIp, isLoopback };
