import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
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
 * POCO Pad M1 menumpuk dari percobaan saya sendiri. Aplikasi cukup dibuka
 * sekali; sesudah itu ia menyegarkan dirinya sendiri.
 *
 * ATURAN TAMPILAN
 * ---------------
 * Status diambil dari SERVER (`state`), bukan disimpulkan dari `phase`.
 * Dashboard sudah memisahkan aktif / mungkin macet / berakhir, dan aplikasi
 * ini tidak boleh punya pendapat sendiri soal itu.
 */

const MONITOR_URL =
  process.env.EXPO_PUBLIC_MONITOR_URL ||
  (Constants.expoConfig && Constants.expoConfig.extra && Constants.expoConfig.extra.monitorUrl) ||
  "http://100.107.65.21:3100";

const POLL_MS = 3000;

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

/** Status dari server -> warna dan label. */
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

/** "3d lalu", "12m lalu", "2j lalu" - dihitung dari jam SERVER bila ada. */
function ago(iso, nowMs) {
  if (!iso) return "";
  const detik = ((nowMs || Date.now()) - new Date(iso).getTime()) / 1000;
  if (!isFinite(detik) || detik < 0) return "baru saja";
  if (detik < 60) return Math.round(detik) + "d lalu";
  if (detik < 3600) return Math.round(detik / 60) + "m lalu";
  if (detik < 86400) return Math.round(detik / 3600) + "j lalu";
  return Math.round(detik / 86400) + "h lalu";
}

export default function App() {
  const [data, setData] = useState(null);
  const [galat, setGalat] = useState(null);
  const [memuat, setMemuat] = useState(true);
  const [menyegarkan, setMenyegarkan] = useState(false);
  const hidup = useRef(true);

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
    // Saat aplikasi kembali dari latar, langsung segarkan: data yang
    // ditampilkan sesudah sekian jam tidak boleh tampak seperti sekarang.
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
  // Jam SERVER, bukan jam perangkat. Emulator/produksi bisa punya jam meleset,
  // dan itu membuat semua label umur salah tanpa sebab yang jelas.
  const jamServer = data && data.now ? new Date(data.now).getTime() : undefined;

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
            sesi.map((s) => <Kartu key={s.session_key} s={s} jamServer={jamServer} />)
          )}

          {(data && data.events && data.events.length > 0) && (
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
    </View>
  );
}

function Kartu({ s, jamServer }) {
  const g = gayaStatus(s.state);
  const total = s.plan_total || 0;
  const selesai = s.plan_done || 0;
  const persen = total ? Math.min(100, Math.round((selesai / total) * 100)) : 0;
  const rencana = Array.isArray(s.plan_json) ? s.plan_json : [];
  const label = s.state === "idle" ? (s.phase || "idle").toUpperCase() : g.label;

  return (
    <View style={[gaya.kartu, { borderColor: g.border }]}>
      <View style={gaya.baris}>
        <View style={[gaya.chip, { backgroundColor: g.chipBg, borderColor: g.border }]}>
          <Text style={[gaya.chipTeks, { color: g.chipFg }]}>{label}</Text>
        </View>
        <Text style={gaya.task} numberOfLines={2}>
          {s.task || "(tanpa task)"}
        </Text>
      </View>

      {s.state === "possibly_stuck" && (
        <Text style={[gaya.catatan, { color: WARNA.kuning }]}>
          tidak ada kabar {ago(s.updated_at, jamServer)} — mungkin berhenti di tengah jalan
        </Text>
      )}
      {s.state === "ended" && (
        <Text style={[gaya.catatan, { color: WARNA.abu }]}>
          berakhir {ago(s.updated_at, jamServer)} — kemungkinan sudah selesai tanpa penutupan
        </Text>
      )}

      <Text style={gaya.meta}>
        {s.machine}
        {s.project_name ? " · " + s.project_name : ""}
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

      {rencana.slice(0, 8).map((p) => {
        const beres = p.status === "done";
        return (
          <Text
            key={p.id || p.text}
            style={[gaya.langkah, beres && gaya.langkahBeres]}
            numberOfLines={2}
          >
            {beres ? "✓ " : "• "}
            {p.text}
          </Text>
        );
      })}
    </View>
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

  kartu: {
    borderWidth: 1,
    borderRadius: 14,
    backgroundColor: WARNA.card,
    padding: 16,
    marginBottom: 14,
  },
  baris: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  chipTeks: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6 },
  task: { color: WARNA.teks, fontSize: 17, fontWeight: "600", flexShrink: 1 },
  catatan: { fontSize: 13, marginTop: 8 },
  meta: { color: WARNA.redup, fontSize: 13, marginTop: 6 },

  barLuar: {
    height: 8,
    backgroundColor: WARNA.garis,
    borderRadius: 999,
    overflow: "hidden",
    marginTop: 12,
  },
  barDalam: { height: "100%", backgroundColor: WARNA.biru },

  langkah: { color: "#9da7b3", fontSize: 14, marginTop: 6 },
  langkahBeres: { color: WARNA.hijau, textDecorationLine: "line-through" },

  aktivitas: { marginTop: 8, borderTopWidth: 1, borderTopColor: WARNA.garis, paddingTop: 14 },
  aktivitasJudul: { color: WARNA.teks, fontSize: 15, fontWeight: "700", marginBottom: 8 },
  aktivitasItem: { color: WARNA.redup, fontSize: 12, marginBottom: 6 },
  aktivitasJenis: { color: WARNA.teks, fontWeight: "600" },
  aktivitasMeta: { color: "#5c6672" },
});

