import Link from "next/link";
import { ArrowLeft, Share2, Eye, EyeOff } from "lucide-react";

/**
 * Halaman penjelasan untuk tautan share.
 *
 * Halaman ini SENGAJA statis dan tidak menyebut kondisi server. Situs ini
 * adalah `output: "export"` - tidak ada runtime - jadi ia tidak bisa tahu
 * apakah server share hidup. Halaman yang mengklaim "server aktif" akan
 * berbohong begitu prosesnya mati; itu persis kegagalan yang pernah terjadi
 * pada halaman /login lama yang menunjuk tunnel yang sudah kedaluwarsa.
 *
 * Rutenya `/share/`, BUKAN `/s/`: `/s/*` dipakai rewrite Netlify ke server
 * share, dan dua aturan yang berebut satu path membuat pemenangnya bergantung
 * pada urutan yang tidak terlihat.
 */
export default function SharePage() {
    return (
        <main className="min-h-screen pt-20 pb-16 px-4 sm:px-6 lg:px-8">
            <div className="max-w-3xl mx-auto">
                <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition mb-8"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Kembali ke beranda
                </Link>

                <div className="flex items-center gap-3 mb-6">
                    <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-sky-100 dark:bg-sky-500/20">
                        <Share2 className="w-5 h-5 text-sky-600 dark:text-sky-400" />
                    </div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
                        Tautan berbagi sesi
                    </h1>
                </div>

                <p className="text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">
                    Tautan berbagi membuka <strong>cuplikan</strong> satu sesi kerja dev
                    workflow: apa yang sedang dikerjakan, sampai langkah mana, dan seberapa
                    jauh Definition of Done-nya terpenuhi. Cuplikan diambil saat halaman
                    dibuka, bukan siaran langsung.
                </p>

                <div className="grid sm:grid-cols-2 gap-4 mb-8">
                    <section className="rounded-xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50/50 dark:bg-emerald-500/5 p-5">
                        <div className="flex items-center gap-2 mb-3">
                            <Eye className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                            <h2 className="font-semibold text-gray-900 dark:text-white">Yang tampil</h2>
                        </div>
                        <ul className="space-y-1.5 text-sm text-gray-600 dark:text-gray-300 list-disc list-inside">
                            <li>Judul task dan jenisnya</li>
                            <li>Fase pekerjaan saat ini</li>
                            <li>Daftar rencana, beserta langkah yang sudah selesai</li>
                            <li>Progres Definition of Done</li>
                            <li>Kapan dimulai, berapa lama berjalan</li>
                        </ul>
                    </section>

                    <section className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50/50 dark:bg-white/5 p-5">
                        <div className="flex items-center gap-2 mb-3">
                            <EyeOff className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                            <h2 className="font-semibold text-gray-900 dark:text-white">Yang tidak tampil</h2>
                        </div>
                        <ul className="space-y-1.5 text-sm text-gray-600 dark:text-gray-300 list-disc list-inside">
                            <li>Nama mesin atau hostname</li>
                            <li>Path dan nama proyek</li>
                            <li>ID sesi internal</li>
                            <li>Nama alat agen yang dipakai</li>
                        </ul>
                    </section>
                </div>

                <div className="rounded-xl border border-amber-200 dark:border-amber-500/20 bg-amber-50/60 dark:bg-amber-500/5 p-5 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                    Tautan bersifat <strong>terbuka</strong>: siapa pun yang memegangnya dapat
                    membacanya, tanpa login. Pemilik dapat mencabutnya kapan saja, dan sesudah
                    dicabut tautan itu berhenti bekerja. Tautan hanya dibuat bila pemilik
                    menekan tombol Bagikan di dashboard atau di aplikasi tablet.
                </div>
            </div>
        </main>
    );
}
