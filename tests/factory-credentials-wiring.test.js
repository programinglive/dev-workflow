import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listTasks, clearTokenCache } from "../factory-client.js";

// Kenapa tes ini ada:
//
// Inilah kejadian 31 Oktober 2026, dipersempit jadi satu tes. Proses MCP
// memegang password LAMA di memorinya, sementara berkas konfigurasi sudah berisi
// password BARU. Sebelum ini, satu-satunya hasil adalah HTTP 400 dan pesan
// "check FACTORY_EMAIL and FACTORY_PASSWORD" - padahal password di berkas sudah
// benar. Satu-satunya jalan keluar adalah restart OpenCode.
//
// Yang harus terjadi sekarang: saat login dengan kredensial lama ditolak,
// kredensial dibaca ulang dari berkas dan login dicoba sekali lagi. Jadi
// perubahan password langsung terpakai tanpa restart.

const WORKSPACE = { projects: [{ id: "p1", name: "proj" }], tasks: [] };

const FRESH_CONFIG_FILE = JSON.stringify({
  mcp: {
    "dev-workflow": {
      environment: {
        FACTORY_URL: "https://factory.contoh",
        FACTORY_EMAIL: "baru@contoh.test",
        FACTORY_PASSWORD: "sandi-baru",
      },
    },
  },
});

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** fetch palsu: password lama ditolak, password baru diterima. */
function fetchWithPasswordCheck() {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("auth-with-password")) {
      const body = JSON.parse(options.body || "{}");
      if (body.password === "sandi-baru") return json({ token: "tok-baru" });
      return json({ message: "Failed to authenticate." }, 400);
    }
    if (url.endsWith("/api/factory")) return json(WORKSPACE);
    return json({}, 404);
  };
  impl.calls = calls;
  return impl;
}

async function withCredentialsFile(body) {
  const dir = mkdtempSync(join(tmpdir(), "factory-creds-"));
  const file = join(dir, "opencode.json");
  writeFileSync(file, FRESH_CONFIG_FILE, "utf8");
  const previous = process.env.FACTORY_CREDENTIALS_FILE;
  process.env.FACTORY_CREDENTIALS_FILE = file;
  try {
    // WAJIB await: tanpa ini blok finally berjalan sebelum promise selesai,
    // sehingga variabel lingkungan sudah dihapus saat tes masih berjalan.
    return await body(file);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_CREDENTIALS_FILE;
    else process.env.FACTORY_CREDENTIALS_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("memakai password baru dari berkas saat password lama ditolak", async () => {
  clearTokenCache();

  await withCredentialsFile(async () => {
    const fetchImpl = fetchWithPasswordCheck();
    const config = {
      url: "https://factory.contoh",
      pocketBaseUrl: "https://pb.contoh",
      token: "",
      email: "baru@contoh.test",
      password: "sandi-lama",
      machineId: "uji",
      agent: "uji",
      deviceId: "d1",
    };

    const tasks = await listTasks(config, {}, fetchImpl);

    assert.deepStrictEqual(tasks, []);

    const logins = fetchImpl.calls.filter((c) => c.url.includes("auth-with-password"));
    assert.strictEqual(logins.length, 2, "login harus dicoba ulang dengan kredensial dari berkas");
    assert.strictEqual(JSON.parse(logins[1].options.body).password, "sandi-baru");
  });

  clearTokenCache();
});

test("tidak mengulang login tanpa henti saat berkas berisi kredensial yang sama", async () => {
  clearTokenCache();

  const dir = mkdtempSync(join(tmpdir(), "factory-creds-same-"));
  const file = join(dir, "opencode.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcp: {
        "dev-workflow": {
          environment: {
            FACTORY_EMAIL: "sama@contoh.test",
            FACTORY_PASSWORD: "sandi-salah",
          },
        },
      },
    }),
    "utf8"
  );

  const previous = process.env.FACTORY_CREDENTIALS_FILE;
  process.env.FACTORY_CREDENTIALS_FILE = file;

  try {
    const fetchImpl = fetchWithPasswordCheck();
    const config = {
      url: "https://factory.contoh",
      pocketBaseUrl: "https://pb.contoh",
      token: "",
      email: "sama@contoh.test",
      password: "sandi-salah",
      machineId: "uji",
      agent: "uji",
      deviceId: "d1",
    };

    await assert.rejects(() => listTasks(config, {}, fetchImpl), /Factory login failed/);

    const logins = fetchImpl.calls.filter((c) => c.url.includes("auth-with-password"));
    assert.strictEqual(logins.length, 1, "kredensial identik tidak boleh memicu login ulang");
  } finally {
    if (previous === undefined) delete process.env.FACTORY_CREDENTIALS_FILE;
    else process.env.FACTORY_CREDENTIALS_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
    clearTokenCache();
  }
});
