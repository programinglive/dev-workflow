import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createShareServer, routeShare } = require("../monitor-server/share-server.cjs");

const TOKEN = "T".repeat(43);
const SESI = {
  live_session_key: "ses_1", task: "Kerjakan", task_type: "feature", phase: "coding",
  plan_json: [{ id: "p1", text: "langkah", status: "open" }],
  plan_done: 0, plan_total: 1, dod_done: 0, dod_total: 2, dod_waived: 0,
  started_at: new Date(Date.now() - 60000).toISOString(),
  updated_at: new Date().toISOString(), session_title: "",
};

const terbuka = [];

function serverWith(row) {
  const query = async (sql) => {
    const teks = String(sql);
    if (/FROM share_links l/.test(teks)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (/UPDATE share_links/.test(teks)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return createShareServer({ query, enableRateLimit: false });
}

async function start(row) {
  const server = serverWith(row);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  terbuka.push(server);
  return "http://127.0.0.1:" + server.address().port;
}

async function tutup(server) {
  const i = terbuka.indexOf(server);
  if (i >= 0) terbuka.splice(i, 1);
  await new Promise((r) => server.close(r));
}

after(async () => {
  for (const s of terbuka.splice(0)) {
    try { await new Promise((r) => s.close(r)); } catch { /* sudah tutup */ }
  }
});

/** Server yang sama sekali tertutup sesudah satu permintaan. */
async function sekali(row, fn) {
  const server = serverWith(row);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn("http://127.0.0.1:" + server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("routing mengenali halaman, health, metode salah, dan path asing", () => {
  assert.deepEqual(routeShare({ pathname: "/s/" + TOKEN, method: "GET" }), { kind: "page", token: TOKEN });
  assert.deepEqual(routeShare({ pathname: "/s/" + TOKEN, method: "HEAD" }), { kind: "page", token: TOKEN });
  assert.deepEqual(routeShare({ pathname: "/s/" + TOKEN, method: "POST" }), { kind: "method" });
  assert.deepEqual(routeShare({ pathname: "/s/" + TOKEN, method: "DELETE" }), { kind: "method" });
  assert.deepEqual(routeShare({ pathname: "/health", method: "GET" }), { kind: "health" });
  assert.deepEqual(routeShare({ pathname: "/", method: "GET" }), { kind: "missing" });
  assert.deepEqual(routeShare({ pathname: "/s/", method: "GET" }), { kind: "missing" });
  assert.deepEqual(routeShare({ pathname: "/s/pendek", method: "GET" }), { kind: "missing" });
});

test("token sah menampilkan halaman dan tidak membocorkan session_key", async () => {
  await sekali(
    { token: TOKEN, session_key: "ses_1", revoked_at: null, views: 1, created_at: new Date().toISOString(), ...SESI },
    async (base) => {
      const r = await fetch(base + "/s/" + TOKEN);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /text\/html/);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.equal(r.headers.get("x-robots-tag"), "noindex");
      const html = await r.text();
      assert.ok(html.includes("Kerjakan"));
      assert.ok(!html.includes("ses_1"), "session_key tidak boleh tampil");
    },
  );
});

test("token tidak dikenal menjawab 404", async () => {
  await sekali(null, async (base) => {
    const r = await fetch(base + "/s/" + TOKEN);
    assert.equal(r.status, 404);
    assert.match(await r.text(), /tidak dikenal/i);
  });
});

test("token dicabut menjawab 410 dengan kalimat yang berbeda", async () => {
  await sekali(
    { token: TOKEN, session_key: "ses_1", revoked_at: new Date().toISOString(), views: 0, ...SESI },
    async (base) => {
      const r = await fetch(base + "/s/" + TOKEN);
      assert.equal(r.status, 410);
      const html = await r.text();
      assert.match(html, /dicabut/i);
      assert.ok(!/tidak dikenal/i.test(html));
    },
  );
});

test("sesi yang sudah dibersihkan menjawab 404, bukan 410", async () => {
  // Token sah dan tidak dicabut, tetapi baris sesinya sudah dibuang retensi.
  await sekali(
    { ...SESI, live_session_key: null, token: TOKEN, session_key: "ses_1", revoked_at: null, views: 0 },
    async (base) => {
      const r = await fetch(base + "/s/" + TOKEN);
      assert.equal(r.status, 404);
      assert.match(await r.text(), /tidak tersimpan/i);
    },
  );
});

test("tidak ada cara menulis lewat port share", async () => {
  await sekali(
    { token: TOKEN, session_key: "ses_1", revoked_at: null, views: 0, ...SESI },
    async (base) => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await fetch(base + "/s/" + TOKEN, { method });
        assert.equal(r.status, 405, method + " harus 405");
        assert.equal(r.headers.get("allow"), "GET, HEAD");
      }
    },
  );
});

test("HEAD mengembalikan header tanpa badan", async () => {
  await sekali(
    { token: TOKEN, session_key: "ses_1", revoked_at: null, views: 0, ...SESI },
    async (base) => {
      const r = await fetch(base + "/s/" + TOKEN, { method: "HEAD" });
      assert.equal(r.status, 200);
      assert.equal(await r.text(), "");
    },
  );
});

test("health menjawab 200", async () => {
  await sekali(null, async (base) => {
    const r = await fetch(base + "/health");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });
});

test("kegagalan database menjadi 503 dengan pesan yang menyebut sebabnya", async () => {
  const query = async () => {
    throw Object.assign(new Error('relation "share_links" does not exist'), { code: "42P01" });
  };
  const s = createShareServer({ query, enableRateLimit: false });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch("http://127.0.0.1:" + s.address().port + "/s/" + TOKEN);
    assert.equal(r.status, 503);
    assert.match(await r.text(), /share_links|belum/i);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test("token yang gagal validasi tidak pernah sampai ke database", async () => {
  let dipanggil = 0;
  const query = async () => { dipanggil += 1; return { rows: [], rowCount: 0 }; };
  const s = createShareServer({ query, enableRateLimit: false });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const base = "http://127.0.0.1:" + s.address().port;
    for (const path of ["/s/pendek", "/s/" + "a".repeat(42) + "+", "/s/..%2f..%2fetc%2fpasswd"]) {
      const r = await fetch(base + path);
      assert.equal(r.status, 404, path + " harus 404");
    }
    assert.equal(dipanggil, 0, "query tidak boleh jalan untuk token berbentuk salah");
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test("rate limit memberi 429 setelah batas, dan bisa dimatikan", async () => {
  const query = async (sql) => {
    const teks = String(sql);
    if (/FROM share_links l/.test(teks)) {
      return { rows: [{ token: TOKEN, revoked_at: null, live_session_key: "s", task: "x", updated_at: new Date().toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const ketat = createShareServer({ query, rateLimitPerMinute: 2 });
  await new Promise((r) => ketat.listen(0, "127.0.0.1", r));
  try {
    const base = "http://127.0.0.1:" + ketat.address().port;
    assert.equal((await fetch(base + "/s/" + TOKEN)).status, 200);
    assert.equal((await fetch(base + "/s/" + TOKEN)).status, 200);
    const ketiga = await fetch(base + "/s/" + TOKEN);
    assert.equal(ketiga.status, 429);
    assert.equal(ketiga.headers.get("retry-after"), "60");
  } finally {
    await new Promise((r) => ketat.close(r));
  }

  const longgar = createShareServer({ query, enableRateLimit: false });
  await new Promise((r) => longgar.listen(0, "127.0.0.1", r));
  try {
    const base = "http://127.0.0.1:" + longgar.address().port;
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await fetch(base + "/s/" + TOKEN)).status, 200);
    }
  } finally {
    await new Promise((r) => longgar.close(r));
  }
});

test("kunjungan dihitung tanpa menahan balasan", async () => {
  let touch = 0;
  const query = async (sql) => {
    const teks = String(sql);
    if (/FROM share_links l/.test(teks)) {
      return { rows: [{ token: TOKEN, revoked_at: null, live_session_key: "s", task: "x", views: 1, updated_at: new Date().toISOString() }], rowCount: 1 };
    }
    if (/UPDATE share_links/.test(teks)) {
      touch += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const s = createShareServer({ query, enableRateLimit: false });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch("http://127.0.0.1:" + s.address().port + "/s/" + TOKEN);
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(touch, 1, "views harus bertambah sesudah balasan dikirim");
  } finally {
    await new Promise((r2) => s.close(r2));
  }
});
