/**
 * Dua kegagalan penyimpanan state, dibedakan supaya pemanggil bisa bersikap
 * berbeda.
 *
 * Sebelum ini, keduanya muncul sebagai `Error` biasa dan berakhir di cabang
 * "Internal server error" yang sama. Akibatnya agen tidak tahu apakah ia harus
 * membaca ulang state (konflik) atau berhenti dan memberi tahu pemiliknya
 * (penyimpanan rusak) - dan jawaban "coba lagi" untuk disk penuh hanya
 * menghabiskan waktu.
 */

/**
 * Dua penulis memakai versi baris yang sama.
 *
 * Bukan kerusakan: baris pemenang utuh. Pemanggil membaca ulang lalu mengulang
 * sekali; bila masih bentrok, pekerjaan itu memang sudah diambil alih.
 */
export class StateConflict extends Error {
  constructor(message, { sessionKey = "", expectedVersion = null, actualVersion = null } = {}) {
    super(message);
    this.name = "StateConflict";
    this.code = "STATE_CONFLICT";
    this.sessionKey = sessionKey;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * Penyimpanan state tidak bisa dipakai: direktori tidak bisa dibuat, berkas
 * terkunci, disk penuh, atau isinya rusak.
 *
 * TIDAK ada jalur cadangan ke berkas JSON. Jalur itu tidak teruji dan justru
 * membuka tabrakan yang sedang kita tutup; lebih baik menolak dengan sebab yang
 * jelas daripada menulis ke tempat yang tidak dipercaya.
 */
export class StateUnavailable extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = "StateUnavailable";
    this.code = "STATE_UNAVAILABLE";
    if (cause) this.cause = cause;
  }
}
