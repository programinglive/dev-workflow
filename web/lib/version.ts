// Versi yang ditampilkan situs datang dari `package.json` root, lewat berkas
// yang dibuat saat build (`scripts/generate-version.mjs`). Jangan menulis angka
// versi langsung di halaman: situs sempat menampilkan 1.9.1 selama berbulan-bulan
// setelah server sudah jauh di atasnya.
export { WEB_VERSION } from "./version.generated";
