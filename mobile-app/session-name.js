/**
 * Nama yang bisa dibaca dan bisa DIBEDAKAN.
 *
 * MASALAH YANG DITUTUP (2 November 2026)
 * --------------------------------------
 * Sesi lama bisa kosong di `task`, `session_title`, dan `project_name`
 * sekaligus. Dua dari sembilan sesi dalam data nyata seperti itu. Dengan label
 * "(tanpa nama)" keduanya tampak identik, sehingga riwayat tidak bisa dipakai
 * mencari apa pun - dan pemilik mengira ada data yang hilang.
 *
 * Potongan `session_key` dipakai sebagai penanda terakhir: tidak cantik, tetapi
 * jujur dan membedakan satu baris dari yang lain.
 */

/** Teks pertama yang tidak kosong, setelah dipangkas. */
function bersihkan(nilai) {
  return typeof nilai === 'string' ? nilai.trim() : '';
}

export function namaSesi(s) {
  if (!s) return '';
  const teks = [s.task, s.session_title, s.project_name].map(bersihkan).find((v) => v.length > 0);
  if (teks) return teks;
  const key = bersihkan(s.session_key);
  if (!key) return 'sesi tanpa penanda';
  return key.length > 14 ? key.slice(0, 14) : key;
}

export default namaSesi;
