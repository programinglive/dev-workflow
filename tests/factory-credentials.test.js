import { test } from "node:test";
import assert from "node:assert";

import {
  defaultCredentialsFile,
  extractFactoryEnv,
  refreshFactoryCredentials,
  describeLoginFailure,
} from "../factory-credentials.js";

// Kenapa tes ini ada:
//
// 31 Oktober 2026 otomasi Factory mati berjam-jam dengan pesan "login failed
// (HTTP 400). Check FACTORY_EMAIL and FACTORY_PASSWORD" padahal password di
// ~/.config/opencode/opencode.json sudah benar dan login langsung ke PocketBase
// menjawab 200. Penyebabnya: proses MCP hidup sejak 30 Oktober dan memegang
// password LAMA di memorinya. Proses MCP tidak pernah memuat ulang env-nya, jadi
// satu-satunya jalan keluar adalah restart OpenCode - dan tidak ada satu pun
// petunjuk ke arah itu di pesan errornya.
//
// Dua hal yang dijaga di sini:
//   1. kredensial dibaca ulang dari berkas konfigurasi saat login gagal, supaya
//      password yang baru dipakai tanpa restart;
//   2. kalau tetap gagal, pesannya menyebut kapan proses ini hidup dan bahwa
//      restart mungkin diperlukan - bukan menyuruh memeriksa password yang sudah
//      benar.

const OPENCODE_CONFIG = JSON.stringify({
  mcp: {
    "dev-workflow": {
      type: "local",
      command: ["node", "index.js"],
      environment: {
        FACTORY_URL: "https://factory.programinglive.com",
        FACTORY_EMAIL: "baru@programinglive.com",
        FACTORY_PASSWORD: "sandi-baru",
      },
    },
    "server-lain": {
      environment: {
        FACTORY_EMAIL: "lain@programinglive.com",
        FACTORY_PASSWORD: "sandi-lain",
      },
    },
  },
});

test("mengekstrak environment milik server yang benar, bukan server lain", () => {
  const env = extractFactoryEnv(OPENCODE_CONFIG, { serverName: "dev-workflow" });

  assert.equal(env.FACTORY_EMAIL, "baru@programinglive.com");
  assert.equal(env.FACTORY_PASSWORD, "sandi-baru");
  assert.equal(env.FACTORY_URL, "https://factory.programinglive.com");
});

test("mengembalikan null untuk berkas yang bukan JSON atau tanpa blok server", () => {
  assert.equal(extractFactoryEnv("{ bukan json", { serverName: "dev-workflow" }), null);
  assert.equal(extractFactoryEnv("{}", { serverName: "dev-workflow" }), null);
  assert.equal(
    extractFactoryEnv(JSON.stringify({ mcp: {} }), { serverName: "dev-workflow" }),
    null
  );
});

test("memakai password baru dari berkas, bukan yang tertinggal di memori", () => {
  const result = refreshFactoryCredentials(
    { email: "baru@programinglive.com", password: "sandi-lama" },
    {
      env: { FACTORY_CREDENTIALS_FILE: "/tmp/opencode.json" },
      readFileImpl: () => OPENCODE_CONFIG,
    }
  );

  assert.equal(result.password, "sandi-baru");
  assert.equal(result.changed, true);
  assert.equal(result.source, "file");
});

test("melaporkan changed=false saat berkas sama dengan yang sudah dipakai", () => {
  const result = refreshFactoryCredentials(
    { email: "baru@programinglive.com", password: "sandi-baru" },
    {
      env: { FACTORY_CREDENTIALS_FILE: "/tmp/opencode.json" },
      readFileImpl: () => OPENCODE_CONFIG,
    }
  );

  assert.equal(result.changed, false);
});

test("tidak melempar saat berkas tidak ada - hanya berarti tidak ada yang bisa disegarkan", () => {
  const result = refreshFactoryCredentials(
    { email: "a@b.c", password: "lama" },
    {
      env: { FACTORY_CREDENTIALS_FILE: "/tmp/tidak-ada.json" },
      readFileImpl: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    }
  );

  assert.equal(result, null);
});

test("membawa token dari berkas bila yang tersedia token, bukan password", () => {
  const config = JSON.stringify({
    mcp: {
      "dev-workflow": {
        environment: {
          FACTORY_URL: "https://factory.programinglive.com",
          FACTORY_TOKEN: "token-dari-berkas",
        },
      },
    },
  });

  const result = refreshFactoryCredentials(
    { email: "", password: "", token: "" },
    {
      env: { FACTORY_CREDENTIALS_FILE: "/tmp/opencode.json" },
      readFileImpl: () => config,
    }
  );

  assert.equal(result.token, "token-dari-berkas");
  assert.equal(result.changed, true);
});

test("mendukung bentuk mcp.servers.<nama> yang dipakai konfigurasi nyata", () => {
  // Konfigurasi OpenCode di mesin ini menaruh server satu tingkat lebih dalam:
  // { mcp: { servers: { "dev-workflow": { environment: ... } } } }.
  // Bentuk ini sempat tidak terbaca dan membuat penyegaran kredensial diam-diam
  // tidak pernah terjadi - persis kegagalan yang ingin dicegah modul ini.
  const config = JSON.stringify({
    mcp: {
      servers: {
        "dev-workflow": {
          environment: {
            FACTORY_EMAIL: "dalam@contoh.test",
            FACTORY_PASSWORD: "sandi-dalam",
          },
        },
      },
    },
  });

  const env = extractFactoryEnv(config, { serverName: "dev-workflow" });
  assert.equal(env.FACTORY_EMAIL, "dalam@contoh.test");
  assert.equal(env.FACTORY_PASSWORD, "sandi-dalam");

  const result = refreshFactoryCredentials(
    { email: "dalam@contoh.test", password: "lama" },
    {
      env: { FACTORY_CREDENTIALS_FILE: "/tmp/opencode.json" },
      readFileImpl: () => config,
    }
  );

  assert.equal(result.password, "sandi-dalam");
  assert.equal(result.changed, true);
});

test("berkas kredensial bawaannya adalah konfigurasi opencode", () => {
  const file = defaultCredentialsFile({ HOME: "/home/uji", USERPROFILE: "C:\\Users\\uji" });
  assert.match(file, /opencode[\\/]opencode\.json$/);
});

test("pesan gagal login menyebut kapan proses ini hidup dan menyarankan restart", () => {
  const pesan = describeLoginFailure({
    status: 400,
    processStartedAt: new Date("2026-10-30T01:12:59.000Z"),
    credentialsChanged: false,
  });

  assert.match(pesan, /HTTP 400/);
  assert.match(pesan, /2026-10-30/);
  assert.match(pesan, /restart/i);
});

test("pesan gagal login menyebut bahwa kredensial di berkas berbeda dari yang dipakai", () => {
  const pesan = describeLoginFailure({
    status: 400,
    processStartedAt: new Date("2026-10-30T01:12:59.000Z"),
    credentialsChanged: true,
  });

  assert.match(pesan, /berbeda|changed/i);
});
