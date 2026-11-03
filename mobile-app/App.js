import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Constants from "expo-constants";
import { namaSesi } from "./session-name";

/**
 * Aplikasi monitor sesi dev-workflow.
 *
 * MENGAPA APLIKASI, BUKAN WEBSITE
 * -------------------------------
 * Website dibuka lewat intent Android, dan setiap pembukaan membuat aktivitas
 * Chrome baru - diukur 2 November 2026: 23 aktivitas di Xiaomi Pad 6 dan 13 di
 * POCO Pad M1 menumpuk. Aplikasi cukup dibuka sekali; sesudah itu ia
 * menyegarkan dirinya sendiri.
 *
 * ATURAN TAMPILAN
 * ---------------
 * 1. Status diambil dari SERVER (`state`), bukan disimpulkan dari `phase`.
 * 2. Umur dihitung dari jam SERVER (`now`), bukan jam perangkat - jam tablet
 *    yang meleset pernah membuat sesi 5 menit tampak "1d lalu".
 * 3. Kartu disusun dua kolom supaya dua sesi terlihat sekaligus tanpa scroll.
 * 4. Kartu bisa ditekan untuk membuka detail lengkap.
 */

const MONITOR_URL =
  process.env.EXPO_PUBLIC_MONITOR_URL ||
  (Constants.expoConfig && Constants.expoConfig.extra && Constants.expoConfig.extra.monitorUrl) ||
  "http://100.107.65.21:3100";

const POLL_MS = 3000;

/** Di bawah lebar ini, dua kolom terlalu sempit - pakai satu kolom. */
const MIN_WIDTH_FOR_TWO_COLUMNS = 560;

const WARNA = {
  bg: "#0b0f14",
  card: "#0f151c",
  garis: "#21262d",
  teks: "#e6edf3",
  redup: "#7d8590",
  biru: "#2f81f7",
  biruMuda: "#79c0ff",
  hijau: "#3fb950",
  kuning: "#e3b341",
  abu: "#8b949e",
};

function gayaStatus(state) {
  switch (state) {
    case "live":
      return { border: WARNA.biru, chipBg: "#1f6feb22", chipFg: WARNA.biruMuda, label: "AKTIF" };
    case "possibly_stuck":
      return { border: "#d29922", chipBg: "#d2992222", chipFg: WARNA.kuning, label: "MUNGKIN MACET" };
    case "ended":
      return { border: WARNA.garis, chipBg: "#6e768122", chipFg: WARNA.abu, label: "BERAKHIR" };
    default:
      return { border: WARNA.garis, chipBg: "#6e768122", chipFg: WARNA.abu, label: "IDLE" };
  }
}

/** Umur dari jam SERVER bila tersedia. */
function ago(iso, nowMs) {
  if (!iso) return "";
  const detik = ((nowMs || Date.now()) - new Date(iso).getTime()) / 1000;
  if (!isFinite(detik) || detik < 0) return "baru saja";
  // Di bawah 10 detik disebut "baru saja", bukan "0d lalu" yang terbaca janggal.
  if (detik < 10) return "baru saja";
  if (detik < 60) return Math.round(detik) + "d lalu";
  if (detik < 3600) return Math.round(detik / 60) + "m lalu";
  if (detik < 86400) return Math.round(detik / 3600) + "j lalu";
  return Math.round(detik / 86400) + "h lalu";
}

/**
 * Durasi sejak task dimulai, bentuk jam:menit:detik.
 *
 * Pemilik meminta "counter timenya biar tau berapa lama task itu selesai".
 * Nilai ini bertambah sendiri setiap detik karena `nowMs` diambil dari jam
 * server yang ikut menyegarkan tiap poll.
 */
function durasi(mulaiIso, nowMs) {
  if (!mulaiIso) return null;
  const mulai = new Date(mulaiIso).getTime();
  if (!isFinite(mulai)) return null;
  const detik = Math.max(0, Math.floor(((nowMs || Date.now()) - mulai) / 1000));
  const j = Math.floor(detik / 3600);
  const m = Math.floor((detik % 3600) / 60);
  const d = detik % 60;
  const dua = (n) => String(n).padStart(2, "0");
  return j > 0 ? `${j}:${dua(m)}:${dua(d)}` : `${m}:${dua(d)}`;
}

export default function App() {
  const [data, setData] = useState(null);
  const [galat, setGalat] = useState(null);
  const [memuat, setMemuat] = useState(true);
  const [menyegarkan, setMenyegarkan] = useState(false);
  const [dipilih, setDipilih] = useState(null);
  const [tab, setTab] = useState("aktif");
  const [filter, setFilter] = useState("semua");
  const hidup = useRef(true);
  const { width } = useWindowDimensions();

  const duaKolom = width >= MIN_WIDTH_FOR_TWO_COLUMNS;

  const ambil = useCallback(async () => {
    try {
      const r = await fetch(MONITOR_URL + "/api/sessions", {
        headers: { "cache-control": "no-store" },
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!hidup.current) return;
      setData(j);
      setGalat(null);
    } catch (e) {
      if (!hidup.current) return;
      setGalat(String(e && e.message ? e.message : e));
    } finally {
      if (hidup.current) {
        setMemuat(false);
        setMenyegarkan(false);
      }
    }
  }, []);

  useEffect(() => {
    hidup.current = true;
    ambil();
    const timer = setInterval(ambil, POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") ambil();
    });
    return () => {
      hidup.current = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [ambil]);

  const tarik = useCallback(() => {
    setMenyegarkan(true);
    ambil();
  }, [ambil]);

  const sesi = (data && data.sessions) || [];
  const health = (data && data.health) || {};
  const jamServer = data && data.now ? new Date(data.now).getTime() : undefined;
  const riwayat = (data && data.history) || [];
  const mesin = (data && data.machines) || [];

  /**
   * Filter riwayat per status.
   *
   * "selesai" TIDAK memakai field status, karena tidak ada status `done` di
   * database: sesi ditutup dengan `phase = 'idle'`. Menyamakan keduanya dengan
   * status turunan akan salah, sebab sesi yang baru saja berhenti melapor juga
   * berstatus `ended` padahal tasknya belum tentu ditutup.
   */
  const FILTER = [
    { id: "semua", label: "Semua", hitung: (h) => h.length },
    { id: "selesai", label: "Selesai", hitung: (h) => h.filter((x) => x.phase === "idle").length },
    { id: "berjalan", label: "Berjalan", hitung: (h) => h.filter((x) => x.state === "live").length },
    { id: "macet", label: "Macet", hitung: (h) => h.filter((x) => x.state === "possibly_stuck").length },
    { id: "berakhir", label: "Berakhir", hitung: (h) => h.filter((x) => x.state === "ended").length },
  ];
  const cocok = (h) => {
    if (filter === "selesai") return h.phase === "idle";
    if (filter === "berjalan") return h.state === "live";
    if (filter === "macet") return h.state === "possibly_stuck";
    if (filter === "berakhir") return h.state === "ended";
    return true;
  };

  // Detail bisa berasal dari kartu aktif MAUPUN baris riwayat.
  const semua = useMemo(() => [...sesi, ...riwayat], [sesi, riwayat]);
  const sesiDipilih = useMemo(
    () => (dipilih ? semua.find((s) => s.session_key === dipilih) || null : null),
    [dipilih, semua],
  );
  // Peringatan dihitung server, memakai baris yang sama dengan yang tampil.
  const alerts = (data && data.alerts) || [];
  // Rekap durasi per proyek: hanya sesi yang sudah ditutup.
  const rekap = (data && data.summary) || [];
  // Jumlah hari ikut dari server supaya layar tidak menebak sendiri.
  const rekapHari = (data && data.summary_days) || 7;

  return (
    <View style={gaya.layar}>
      <View style={gaya.header}>
        <Text style={gaya.judul}>Dev Workflow Monitor</Text>
        <Pressable onPress={() => Linking.openURL(MONITOR_URL)}>
          <Text style={[gaya.sub, { textDecorationLine: "underline" }]}>
            {sesi.length} sesi · {MONITOR_URL.replace(/^https?:\/\//, "")}
          </Text>
        </Pressable>
      </View>

      {galat ? (
        <View style={[gaya.kotak, gaya.kotakGalat]}>
          <Text style={gaya.kotakJudul}>Tidak bisa menghubungi monitor</Text>
          <Text style={gaya.kotakTeks}>
            {galat}
            {"\n"}Periksa apakah perangkat ini tersambung ke Tailscale.
          </Text>
        </View>
      ) : health.stale ? (
        <View style={[gaya.kotak, gaya.kotakPeringatan]}>
          <Text style={gaya.kotakJudul}>Tidak ada laporan masuk</Text>
          <Text style={gaya.kotakTeks}>
            {health.never
              ? "Belum pernah ada laporan sama sekali. Periksa URL dan token di mesin pengirim."
              : "Terakhir " +
                ago(health.lastReportAt, jamServer) +
                ". Bisa berarti tidak ada yang bekerja, atau pelaporannya terputus."}
          </Text>
        </View>
      ) : null}

      {alerts.length > 0 && tab !== "info" ? (
        <View style={[gaya.kotak, gaya.kotakPeringatan]}>
          <Text style={gaya.kotakJudul}>{alerts.length} hal perlu dilihat</Text>
          {alerts.slice(0, 4).map((a, i) => {
            const bisaDiketuk = Boolean(a.session_key);
            return (
              <Pressable
                key={i}
                disabled={!bisaDiketuk}
                onPress={() => bisaDiketuk && setDipilih(a.session_key)}
                style={({ pressed }) => [pressed && gaya.kartuDitekan]}
              >
                <Text style={gaya.kotakTeks}>
                  {a.kind === "sesi_macet" ? "◆ " : "● "}
                  {a.pesan}
                  {bisaDiketuk ? "  ›" : ""}
                </Text>
              </Pressable>
            );
          })}
          {alerts.length > 4 ? (
            <Text style={gaya.kotakTeks}>dan {alerts.length - 4} lagi</Text>
          ) : null}
          <Text style={[gaya.kotakTeks, { marginTop: 6, opacity: 0.75 }]}>
            Dari server tidak bisa dibedakan antara macet dan task yang sudah
            ditutup lalu ditinggal.
          </Text>
        </View>
      ) : null}

      {memuat && !data ? (
        <ActivityIndicator size="large" color={WARNA.biru} style={{ marginTop: 60 }} />
      ) : (
        <ScrollView
          contentContainerStyle={gaya.daftar}
          refreshControl={
            <RefreshControl refreshing={menyegarkan} onRefresh={tarik} tintColor={WARNA.biru} />
          }
        >
          {tab === "aktif" && (
            <>
              {sesi.length === 0 ? (
                <Text style={gaya.kosong}>belum ada sesi melapor</Text>
              ) : (
                <View style={[gaya.grid, !duaKolom && gaya.gridSatu]}>
                  {sesi.map((s) => (
                    <View key={s.session_key} style={duaKolom ? gaya.sel : gaya.selPenuh}>
                      <Kartu s={s} jamServer={jamServer} onPress={() => setDipilih(s.session_key)} />
                    </View>
                  ))}
                </View>
              )}

              {data && data.events && data.events.length > 0 && (
                <View style={gaya.aktivitas}>
                  <Text style={gaya.aktivitasJudul}>Aktivitas terakhir</Text>
                  {data.events.slice(0, 8).map((e, i) => (
                    <Text key={i} style={gaya.aktivitasItem}>
                      <Text style={gaya.aktivitasJenis}>{e.kind}</Text> {e.detail}
                      <Text style={gaya.aktivitasMeta}>
                        {"  · "}
                        {e.project_name} · {ago(e.at, jamServer)}
                      </Text>
                    </Text>
                  ))}
                </View>
              )}
            </>
          )}

          {tab === "riwayat" && (
            <>
              <View style={gaya.filterBaris}>
                {FILTER.map((f) => {
                  const aktif = filter === f.id;
                  const jumlah = f.hitung(riwayat);
                  return (
                    <Pressable
                      key={f.id}
                      onPress={() => setFilter(f.id)}
                      style={[gaya.filterChip, aktif && gaya.filterChipAktif]}
                    >
                      <Text style={[gaya.filterTeks, aktif && gaya.filterTeksAktif]}>
                        {f.label} {jumlah > 0 ? jumlah : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {riwayat.filter(cocok).length === 0 ? (
                <Text style={gaya.kosong}>
                  tidak ada sesi dengan status "{FILTER.find((f) => f.id === filter).label.toLowerCase()}"
                  {"\n"}({riwayat.length} sesi dalam 7 hari terakhir)
                </Text>
              ) : (
                riwayat
                  .filter(cocok)
                  .map((h) => (
                    <Pressable
                      key={h.session_key}
                      onPress={() => setDipilih(h.session_key)}
                      style={({ pressed }) => [gaya.riwayatKartu, pressed && gaya.kartuDitekan]}
                    >
                      <View style={gaya.baris}>
                        <View
                          style={[
                            gaya.chip,
                            { borderColor: gayaStatus(h.state).border },
                            { backgroundColor: gayaStatus(h.state).chipBg },
                          ]}
                        >
                          <Text
                            style={[gaya.chipTeks, { color: gayaStatus(h.state).chipFg }]}
                          >
                            {h.phase === "idle" ? "SELESAI" : gayaStatus(h.state).label}
                          </Text>
                        </View>
                        {h.agent_tool ? (
                          <View style={gaya.chipAlat}>
                            <Text style={gaya.chipAlatTeks}>
                              {String(h.agent_tool).toUpperCase()}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={gaya.riwayatNama} numberOfLines={2}>
                        {namaSesi(h)}
                      </Text>
                      <Text style={gaya.riwayatMeta} numberOfLines={1}>
                        {h.machine}
                        {h.project_name ? " · " + h.project_name : ""} ·{" "}
                        {h.duration_label ? "⏱ " + h.duration_label : "durasi tidak tercatat"} ·{" "}
                        {ago(h.updated_at, jamServer)}
                      </Text>
                    </Pressable>
                  ))
              )}
            </>
          )}

          {tab === "mesin" && (
            <>
              {mesin.length === 0 ? (
                <Text style={gaya.kosong}>belum ada mesin melapor</Text>
              ) : (
                mesin.map((m) => (
                  <View key={m.machine} style={gaya.riwayatKartu}>
                    <View style={gaya.baris}>
                      <View
                        style={[
                          gaya.titik,
                          { backgroundColor: m.stale ? WARNA.kuning : WARNA.hijau },
                        ]}
                      />
                      <Text style={gaya.mesinNamaBesar}>{m.machine}</Text>
                    </View>
                    <Text style={gaya.riwayatMeta}>
                      terakhir melapor {ago(m.last_seen, jamServer)}
                      {m.stale ? " · sudah lama tidak melapor" : ""}
                    </Text>
                    <Text style={gaya.riwayatMeta} numberOfLines={1}>
                      {m.sessions} sesi · fase terakhir {m.last_phase || "-"}
                      {m.last_project ? " · " + m.last_project : ""}
                    </Text>
                  </View>
                ))
              )}
            </>
          )}

          {tab === "rekap" && (
            <>
              {rekap.length === 0 ? (
                <Text style={gaya.kosong}>
                  belum ada sesi selesai dalam {rekapHari} hari terakhir
                </Text>
              ) : (
                <>
                  <View style={gaya.kotak}>
                    <Text style={gaya.kotakJudul}>
                      Waktu per proyek · {rekapHari} hari terakhir
                    </Text>
                    <Text style={gaya.kotakTeks}>
                      Hanya sesi yang sudah ditutup, karena durasi sesi berjalan
                      masih bertambah dan tidak bisa dibandingkan.
                    </Text>
                  </View>
                  {rekap.map((r) => (
                    <View key={r.project} style={gaya.riwayatKartu}>
                      <View style={gaya.baris}>
                        <Text style={[gaya.mesinNamaBesar, { flex: 1 }]} numberOfLines={1}>
                          {r.project}
                        </Text>
                        <Text style={gaya.rekapDurasi}>{r.total_label || "-"}</Text>
                      </View>
                      <Text style={gaya.riwayatMeta}>
                        {r.sessions} sesi selesai · terakhir {ago(r.last_at, jamServer)}
                      </Text>
                    </View>
                  ))}
                </>
              )}
            </>
          )}

          {tab === "info" && (
            <>
              <View style={gaya.kotak}>
                <Text style={gaya.kotakJudul}>Tentang</Text>
                <Text style={gaya.kotakTeks}>
                  Dashboard sesi dev-workflow dari semua mesin.{"\n"}
                  Membaca tanpa login; penulisan wajib token.{"\n"}
                  Data tidak pernah dihapus otomatis.
                </Text>
              </View>
              <View style={gaya.kotak}>
                <Text style={gaya.kotakJudul}>Server</Text>
                <Text style={gaya.kotakTeks}>{MONITOR_URL}</Text>
                <Text style={[gaya.kotakTeks, { marginTop: 6 }]}>
                  {sesi.length} sesi aktif · {riwayat.length} riwayat · {mesin.length} mesin
                </Text>
                <Text style={[gaya.kotakTeks, { marginTop: 6 }]}>
                  diperbarui tiap {Math.round(POLL_MS / 1000)} detik
                </Text>
                <Pressable
                  onPress={() => Linking.openURL(MONITOR_URL)}
                  style={gaya.tombolBrowser}
                >
                  <Text style={gaya.tombolBrowserTeks}>🌐 Buka di Browser</Text>
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      )}

      <View style={gaya.tabBar}>
        {[
          { id: "aktif", ikon: "▦", label: "Aktif" },
          { id: "riwayat", ikon: "☰", label: "Riwayat" },
          { id: "rekap", ikon: "Σ", label: "Rekap" },
          { id: "mesin", ikon: "▣", label: "Mesin" },
          { id: "info", ikon: "ⓘ", label: "Info" },
        ].map((t) => {
          const aktif = tab === t.id;
          return (
            <Pressable
              key={t.id}
              onPress={() => setTab(t.id)}
              style={gaya.tabItem}
              android_ripple={{ color: "#ffffff10" }}
            >
              <Text style={[gaya.tabIkon, aktif && gaya.tabIkonAktif]}>{t.ikon}</Text>
              <Text style={[gaya.tabLabel, aktif && gaya.tabLabelAktif]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <DetailSesi
        s={sesiDipilih}
        jamServer={jamServer}
        onClose={() => setDipilih(null)}
      />
    </View>
  );
}

/** Batas langkah yang ditampilkan di kartu; sisanya lewat detail. */
const LANGKAH_DI_KARTU = 2;

function Kartu({ s, jamServer, onPress }) {
  const g = gayaStatus(s.state);
  const total = s.plan_total || 0;
  const selesai = s.plan_done || 0;
  const persen = total ? Math.min(100, Math.round((selesai / total) * 100)) : 0;
  const rencana = Array.isArray(s.plan_json) ? s.plan_json : [];
  const label = s.state === "idle" ? (s.phase || "idle").toUpperCase() : g.label;
  const sisaLangkah = Math.max(0, rencana.length - LANGKAH_DI_KARTU);

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: "#ffffff14" }}
      style={({ pressed }) => [
        gaya.kartu,
        { borderColor: g.border },
        pressed && gaya.kartuDitekan,
      ]}
    >
      <View style={gaya.baris}>
        <View style={[gaya.chip, { backgroundColor: g.chipBg, borderColor: g.border }]}>
          <Text style={[gaya.chipTeks, { color: g.chipFg }]}>{label}</Text>
        </View>
        {/* Alat AI pemanggil: codex / antigravity / opencode / unknown. */}
        <View style={gaya.chipAlat}>
          <Text style={gaya.chipAlatTeks}>{String(s.agent_tool || "unknown").toUpperCase()}</Text>
        </View>
        {(() => {
          const t = durasi(s.started_at, jamServer);
          return t ? (
            <View style={gaya.timer}>
              <Text style={gaya.timerTeks}>⏱ {t}</Text>
            </View>
          ) : null;
        })()}
      </View>

      <Text style={gaya.task} numberOfLines={2}>
        {s.task || "(tanpa task)"}
      </Text>

      {/* Judul percakapan OpenCode: menjelaskan sesi mana ini, tanpa kode ses_. */}
      {s.session_title ? (
        <Text style={gaya.judulSesi} numberOfLines={1}>
          💬 {s.session_title}
        </Text>
      ) : null}

      {/* Nama proyek ditonjolkan karena pemilik memintanya eksplisit. */}
      {s.project_name ? (
        <Text style={gaya.proyek} numberOfLines={1}>
          {s.project_name}
        </Text>
      ) : null}

      {s.state === "possibly_stuck" && (
        <Text style={[gaya.catatan, { color: WARNA.kuning }]}>
          tidak ada kabar {ago(s.updated_at, jamServer)}
        </Text>
      )}
      {s.state === "ended" && (
        <Text style={[gaya.catatan, { color: WARNA.abu }]}>
          berakhir {ago(s.updated_at, jamServer)}
        </Text>
      )}

      <Text style={gaya.meta} numberOfLines={1}>
        {s.machine}
        {s.task_type ? " · " + s.task_type : ""} · {ago(s.updated_at, jamServer)}
      </Text>

      {total > 0 && (
        <>
          <View style={gaya.barLuar}>
            <View style={[gaya.barDalam, { width: persen + "%" }]} />
          </View>
          <Text style={gaya.meta}>
            rencana {selesai}/{total} · DoD {s.dod_done || 0}/{s.dod_total || 0}
            {s.dod_waived ? " (" + s.dod_waived + " dilewati)" : ""}
          </Text>
        </>
      )}

      {rencana.slice(0, LANGKAH_DI_KARTU).map((p) => {
        const beres = p.status === "done";
        return (
          <Text
            key={p.id || p.text}
            style={[gaya.langkah, beres && gaya.langkahBeres]}
            numberOfLines={1}
          >
            {beres ? "✓ " : "• "}
            {p.text}
          </Text>
        );
      })}

      <View style={gaya.kartuKaki}>
        {sisaLangkah > 0 && <Text style={gaya.sisa}>+{sisaLangkah} langkah lagi</Text>}
        <Text style={gaya.ketuk}>ketuk untuk detail ›</Text>
      </View>
    </Pressable>
  );
}

function DetailSesi({ s, jamServer, onClose }) {
  /**
   * Hook harus dipanggil SEBELUM `return null` di bawah.
   *
   * Kalau tidak, jumlah hook berbeda antara render dengan sesi dan tanpa
   * sesi, dan React melempar "Rendered fewer hooks than expected" - layar
   * tablet mati total, bukan sekadar tombolnya.
   */
  const [tautan, setTautan] = useState(null);
  const [galatBagikan, setGalatBagikan] = useState(null);
  const [sibukBagikan, setSibukBagikan] = useState(false);

  if (!s) return null;
  const g = gayaStatus(s.state);
  const rencana = Array.isArray(s.plan_json) ? s.plan_json : [];
  const total = s.plan_total || 0;
  const selesai = s.plan_done || 0;
  const label = s.state === "idle" ? (s.phase || "idle").toUpperCase() : g.label;

  /**
   * Minta tautan share, lalu buka sheet bagikan Android.
   *
   * CATATAN ORIGIN: React Native TIDAK mengirim header `Origin` - ia bukan
   * browser dan tidak punya konsep origin. Server share karena itu mengizinkan
   * Origin KOSONG tetapi tetap mewajibkan header `X-Devwf-Share`. Tanpa aturan
   * itu, tombol ini akan selalu 403 di tablet sementara dashboard browser
   * tampak normal - kegagalan yang paling sulit dilacak.
   */
  async function bagikan() {
    if (sibukBagikan) return;
    setSibukBagikan(true);
    setGalatBagikan(null);
    try {
      const r = await fetch(MONITOR_URL + "/api/share", {
        method: "POST",
        headers: { "content-type": "application/json", "x-devwf-share": "1" },
        body: JSON.stringify({ sessionKey: s.session_key }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "server menjawab " + r.status);
      setTautan(body.url);
      await Share.share({
        message: body.url + "\n" + (s.task || s.session_title || "Sesi dev workflow"),
        url: body.url,
      });
    } catch (e) {
      setGalatBagikan(e.message || String(e));
    } finally {
      setSibukBagikan(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={gaya.modalLatar}>
        <View style={gaya.modalKotak}>
          <View style={gaya.baris}>
            <View style={[gaya.chip, { backgroundColor: g.chipBg, borderColor: g.border }]}>
              <Text style={[gaya.chipTeks, { color: g.chipFg }]}>{label}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={16} style={gaya.tutup}>
              <Text style={gaya.tutupTeks}>✕</Text>
            </Pressable>
          </View>

          <Text style={gaya.modalJudul}>{s.task || "(tanpa task)"}</Text>
          {s.session_title ? (
            <Text style={gaya.judulSesi}>💬 {s.session_title}</Text>
          ) : null}
          {s.project_name ? (
            <Text style={[gaya.proyek, { fontSize: 15 }]}>{s.project_name}</Text>
          ) : null}
          <Text style={gaya.meta}>
            {s.machine}
            {s.task_type ? " · " + s.task_type : ""} · {ago(s.updated_at, jamServer)}
          </Text>
          <Text style={gaya.meta}>{s.project_path || ""}</Text>
          {(() => {
            const t = durasi(s.started_at, jamServer);
            return t ? (
              <Text style={[gaya.timerTeks, { marginTop: 8 }]}>⏱ berjalan {t}</Text>
            ) : (
              <Text style={[gaya.meta, { color: WARNA.kuning }]}>
                ⏱ waktu mulai tidak tercatat (sesi ini dibuat sebelum perbaikan
                started_at)
              </Text>
            );
          })()}

          <ScrollView style={gaya.modalIsi}>
            {total > 0 && (
              <>
                <Text style={gaya.bagianJudul}>Rencana {selesai}/{total}</Text>
                <View style={gaya.barLuar}>
                  <View
                    style={[
                      gaya.barDalam,
                      { width: Math.min(100, Math.round((selesai / total) * 100)) + "%" },
                    ]}
                  />
                </View>
                {rencana.map((p) => {
                  const beres = p.status === "done";
                  return (
                    <Text
                      key={p.id || p.text}
                      style={[gaya.langkah, beres && gaya.langkahBeres]}
                    >
                      {beres ? "✓ " : "• "}
                      {p.text}
                    </Text>
                  );
                })}
              </>
            )}

            <Text style={gaya.bagianJudul}>
              Definition of Done {s.dod_done || 0}/{s.dod_total || 0}
              {s.dod_waived ? " · " + s.dod_waived + " dilewati" : ""}
            </Text>
            {(s.dod_total || 0) === 0 && (
              <Text style={gaya.langkah}>(belum ada item DoD)</Text>
            )}

            <Text style={gaya.bagianJudul}>Sesi</Text>
            <Text style={gaya.langkah}>kunci: {s.session_key}</Text>
            <Text style={gaya.langkah}>fase: {s.phase}</Text>
            <Text style={gaya.langkah}>status: {s.state_label || s.state || "-"}</Text>
            <Text style={gaya.langkah}>alat: {s.agent_tool || "unknown"}</Text>
            <Text style={gaya.langkah}>
              terakhir melapor: {ago(s.updated_at, jamServer)}
            </Text>
          </ScrollView>

          {galatBagikan ? (
            <Text style={gaya.galatBagikan}>Gagal membagikan: {galatBagikan}</Text>
          ) : null}
          {tautan ? (
            <Text selectable style={gaya.tautanTeks}>
              {tautan}
            </Text>
          ) : null}

          <View style={gaya.barisTombol}>
            <Pressable
              onPress={bagikan}
              disabled={sibukBagikan}
              style={[gaya.tombolBagikan, sibukBagikan && gaya.tombolMati]}
            >
              <Text style={gaya.tombolBagikanTeks}>
                {sibukBagikan ? "menyiapkan..." : "Bagikan"}
              </Text>
            </Pressable>
            <Pressable onPress={onClose} style={[gaya.tombolTutup, gaya.tombolTutupKecil]}>
              <Text style={gaya.tombolTutupTeks}>Tutup</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const gaya = StyleSheet.create({
  layar: { flex: 1, backgroundColor: WARNA.bg, paddingTop: 28, paddingHorizontal: 18 },
  header: { marginBottom: 14 },
  judul: { color: WARNA.teks, fontSize: 22, fontWeight: "700" },
  sub: { color: WARNA.redup, fontSize: 13, marginTop: 2 },

  kotak: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 14 },
  kotakPeringatan: { borderColor: "#d2992255", backgroundColor: "#d299221a" },
  kotakGalat: { borderColor: "#f8514955", backgroundColor: "#f851491a" },
  kotakJudul: { color: WARNA.kuning, fontWeight: "700", fontSize: 15, marginBottom: 4 },
  kotakTeks: { color: WARNA.teks, fontSize: 14, lineHeight: 20 },
  tombolBrowser: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: "#1a7fd4",
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  tombolBrowserTeks: { color: "#fff", fontWeight: "700", fontSize: 14 },

  daftar: { paddingBottom: 40 },
  kosong: { color: WARNA.redup, textAlign: "center", marginTop: 60, fontSize: 16 },

  // Dua kolom: kartu mengisi setengah lebar. `flexWrap` membuat baris baru
  // otomatis, jadi 2 sesi duduk berdampingan dan 4 sesi jadi 2x2.
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  gridSatu: { flexDirection: "column" },
  sel: { width: "49%", marginBottom: 14 },
  selPenuh: { width: "100%", marginBottom: 14 },

  kartu: {
    borderWidth: 1,
    borderRadius: 14,
    backgroundColor: WARNA.card,
    padding: 14,
    flexGrow: 1,
  },
  kartuDitekan: { opacity: 0.7 },
  baris: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  chipTeks: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  timer: {
    borderWidth: 1,
    borderColor: "#3fb95055",
    backgroundColor: "#3fb9501a",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  timerTeks: { color: WARNA.hijau, fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  chipAlat: {
    borderWidth: 1,
    borderColor: "#a371f755",
    backgroundColor: "#a371f71a",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  chipAlatTeks: { color: "#d2a8ff", fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  proyek: { color: WARNA.biruMuda, fontSize: 13, fontWeight: "600", marginTop: 6 },
  judulSesi: { color: "#b9c3cf", fontSize: 12, fontStyle: "italic", marginTop: 6 },
  task: { color: WARNA.teks, fontSize: 16, fontWeight: "600", flexShrink: 1, marginTop: 8 },
  catatan: { fontSize: 12, marginTop: 6 },
  meta: { color: WARNA.redup, fontSize: 12, marginTop: 5 },

  barLuar: {
    height: 7,
    backgroundColor: WARNA.garis,
    borderRadius: 999,
    overflow: "hidden",
    marginTop: 10,
  },
  barDalam: { height: "100%", backgroundColor: WARNA.biru },

  langkah: { color: "#9da7b3", fontSize: 13, marginTop: 5 },
  langkahBeres: { color: WARNA.hijau, textDecorationLine: "line-through" },

  kartuKaki: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 10,
  },
  sisa: { color: WARNA.redup, fontSize: 11 },
  ketuk: { color: WARNA.biruMuda, fontSize: 11 },

  aktivitas: { marginTop: 8, borderTopWidth: 1, borderTopColor: WARNA.garis, paddingTop: 14 },
  mesinBaris: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  titik: { width: 8, height: 8, borderRadius: 999 },
  mesinNama: { color: WARNA.teks, fontSize: 13, fontWeight: "600", minWidth: 90 },
  mesinMeta: { color: WARNA.redup, fontSize: 12, flexShrink: 1 },
  riwayatBaris: { marginBottom: 8 },
  riwayatKartu: {
    borderWidth: 1,
    borderColor: WARNA.garis,
    borderRadius: 12,
    backgroundColor: WARNA.card,
    padding: 14,
    marginBottom: 10,
  },
  mesinNamaBesar: { color: WARNA.teks, fontSize: 16, fontWeight: "700" },
  rekapDurasi: { color: WARNA.biruMuda, fontSize: 16, fontWeight: "700" },

  filterBaris: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  filterChip: {
    borderWidth: 1,
    borderColor: WARNA.garis,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: WARNA.card,
  },
  filterChipAktif: { borderColor: WARNA.biru, backgroundColor: "#1f6feb22" },
  filterTeks: { color: WARNA.redup, fontSize: 12, fontWeight: "600" },
  filterTeksAktif: { color: WARNA.biruMuda },

  tabBar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: WARNA.garis,
    backgroundColor: "#0d1219",
    paddingBottom: 10,
    paddingTop: 8,
  },
  tabItem: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 4 },
  tabIkon: { color: WARNA.redup, fontSize: 18, lineHeight: 22 },
  tabIkonAktif: { color: WARNA.biruMuda },
  tabLabel: { color: WARNA.redup, fontSize: 11, marginTop: 2 },
  tabLabelAktif: { color: WARNA.biruMuda, fontWeight: "700" },
  riwayatNama: { color: WARNA.teks, fontSize: 13, fontWeight: "600" },
  riwayatMeta: { color: WARNA.redup, fontSize: 11, marginTop: 1 },
  aktivitasJudul: { color: WARNA.teks, fontSize: 15, fontWeight: "700", marginBottom: 8 },
  aktivitasItem: { color: WARNA.redup, fontSize: 12, marginBottom: 6 },
  aktivitasJenis: { color: WARNA.teks, fontWeight: "600" },
  aktivitasMeta: { color: "#5c6672" },

  modalLatar: {
    flex: 1,
    backgroundColor: "#000000cc",
    justifyContent: "center",
    padding: 24,
  },
  modalKotak: {
    backgroundColor: WARNA.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: WARNA.garis,
    padding: 20,
    maxHeight: "90%",
  },
  modalJudul: { color: WARNA.teks, fontSize: 20, fontWeight: "700", marginTop: 8 },
  modalIsi: { marginTop: 12 },
  bagianJudul: { color: WARNA.teks, fontSize: 14, fontWeight: "700", marginTop: 16 },
  tutup: { marginLeft: "auto", paddingHorizontal: 6 },
  tutupTeks: { color: WARNA.redup, fontSize: 20, fontWeight: "700" },
  tombolTutup: {
    marginTop: 16,
    backgroundColor: "#1f6feb33",
    borderWidth: 1,
    borderColor: "#1f6feb88",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  tombolTutupTeks: { color: WARNA.biruMuda, fontWeight: "700", fontSize: 15 },
  barisTombol: { flexDirection: "row", gap: 10, marginTop: 16 },
  tombolTutupKecil: { flex: 1, marginTop: 0 },
  tombolBagikan: {
    flex: 1,
    backgroundColor: "#2f81f7",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  tombolBagikanTeks: { color: "#04121f", fontWeight: "700", fontSize: 15 },
  tombolMati: { opacity: 0.55 },
  galatBagikan: { color: WARNA.kuning, fontSize: 13, marginTop: 12 },
  tautanTeks: { color: WARNA.biruMuda, fontSize: 13, marginTop: 10, lineHeight: 18 },
});

