import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Constants from "expo-constants";

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

  // Detail ikut data terbaru: kalau sesinya berubah saat modal terbuka,
  // isinya tidak boleh membeku di salinan lama.
  const sesiDipilih = useMemo(
    () => (dipilih ? sesi.find((s) => s.session_key === dipilih) || null : null),
    [dipilih, sesi],
  );

  return (
    <View style={gaya.layar}>
      <View style={gaya.header}>
        <Text style={gaya.judul}>Dev Workflow Monitor</Text>
        <Text style={gaya.sub}>
          {sesi.length} sesi · {MONITOR_URL.replace(/^https?:\/\//, "")}
        </Text>
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

      {memuat && !data ? (
        <ActivityIndicator size="large" color={WARNA.biru} style={{ marginTop: 60 }} />
      ) : (
        <ScrollView
          contentContainerStyle={gaya.daftar}
          refreshControl={
            <RefreshControl refreshing={menyegarkan} onRefresh={tarik} tintColor={WARNA.biru} />
          }
        >
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

          {data && data.machines && data.machines.length > 0 && (
            <View style={gaya.aktivitas}>
              <Text style={gaya.aktivitasJudul}>Mesin terhubung</Text>
              {data.machines.map((m) => (
                <View key={m.machine} style={gaya.mesinBaris}>
                  <View
                    style={[
                      gaya.titik,
                      { backgroundColor: m.online ? WARNA.hijau : WARNA.abu },
                    ]}
                  />
                  <Text style={gaya.mesinNama}>{m.machine}</Text>
                  <Text style={gaya.mesinMeta} numberOfLines={1}>
                    {m.online ? "online" : "offline"} · {ago(m.last_seen, jamServer)}
                    {m.last_project ? " · " + m.last_project : ""}
                  </Text>
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
        </ScrollView>
      )}

      <DetailSesi
        s={sesiDipilih}
        jamServer={jamServer}
        onClose={() => setDipilih(null)}
      />
    </View>
  );
}

/** Batas langkah yang ditampilkan di kartu; sisanya lewat detail. */
const LANGKAH_DI_KARTU = 4;

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
  if (!s) return null;
  const g = gayaStatus(s.state);
  const rencana = Array.isArray(s.plan_json) ? s.plan_json : [];
  const total = s.plan_total || 0;
  const selesai = s.plan_done || 0;
  const label = s.state === "idle" ? (s.phase || "idle").toUpperCase() : g.label;

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

          <Pressable onPress={onClose} style={gaya.tombolTutup}>
            <Text style={gaya.tombolTutupTeks}>Tutup</Text>
          </Pressable>
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
});
