import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Header token pada pelapor.
 *
 * Server monitor mewajibkan `Authorization: Bearer <token>` untuk endpoint
 * tulis. Kalau pelapor tidak mengirimnya, setiap mesin akan tampak "tidak
 * pernah update" tanpa sebab yang jelas - jadi bentuk header ini diuji
 * langsung, bukan diasumsikan.
 */

function captureFetch(sink) {
  return async (url, opts) => {
    sink.push({ url: String(url), headers: (opts && opts.headers) || {} });
    return { ok: true };
  };
}

const ENV = { DEVWF_MONITOR_URL: "http://monitor.test:3100", DEVWF_MACHINE: "uji" };

test("token ikut terkirim sebagai Bearer saat dikonfigurasi", async () => {
  const { reportEvent } = await import("../monitor.js");
  const sink = [];
  await reportEvent({
    env: { ...ENV, DEVWF_MONITOR_TOKEN: "  token-uji  " },
    event: { kind: "task_started", detail: "x" },
    fetchImpl: captureFetch(sink),
  });
  assert.equal(sink.length, 1);
  // Spasi di tepi dibuang: token yang tersalin dengan spasi tidak boleh gagal
  // dengan pesan yang membingungkan.
  assert.equal(sink[0].headers.authorization, "Bearer token-uji");
});

test("tanpa token, header tidak dikirim sama sekali", async () => {
  const { reportEvent } = await import("../monitor.js");
  const sink = [];
  await reportEvent({
    env: { ...ENV },
    event: { kind: "task_started" },
    fetchImpl: captureFetch(sink),
  });
  assert.equal(sink.length, 1);
  assert.equal(sink[0].headers.authorization, undefined);
  assert.equal(sink[0].headers["content-type"], "application/json");
});

test("snapshot juga membawa token", async () => {
  const { reportSnapshot } = await import("../monitor.js");
  const sink = [];
  await reportSnapshot({
    env: { ...ENV, DEVWF_MONITOR_TOKEN: "abc" },
    snapshot: { sessionKey: "s1", machine: "uji", phase: "coding" },
    fetchImpl: captureFetch(sink),
  });
  assert.equal(sink[0].headers.authorization, "Bearer abc");
});

test("URL monitor kosong tetap mematikan pelaporan", async () => {
  const { reportEvent } = await import("../monitor.js");
  const sink = [];
  const sent = await reportEvent({
    env: { DEVWF_MONITOR_URL: "", DEVWF_MONITOR_TOKEN: "abc" },
    event: { kind: "task_started" },
    fetchImpl: captureFetch(sink),
  });
  assert.equal(sent, false);
  assert.equal(sink.length, 0);
});
