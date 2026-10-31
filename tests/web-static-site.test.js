import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The marketing site is a static export, so it has no server at runtime.
 *
 * Two things broke because that was forgotten:
 *
 *   1. The header linked to /login and /history, and the login page posted to a
 *      Cloudflare quick tunnel that had long expired. Every click ended in
 *      "Network error". A button that cannot work is worse than no button.
 *   2. The docs page hard-coded "Version: 1.9.1" while the package was at
 *      1.13.16, so the site advertised a release that had not existed for months.
 *
 * These tests pin the invariants rather than the markup, so the pages can be
 * redesigned without weakening them.
 */

const webRoot = fileURLToPath(new URL("../web", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function readIfExists(relativePath) {
    const full = path.join(webRoot, relativePath);
    if (!existsSync(full)) return null;
    return readFile(full, "utf8");
}

test("situs statis tidak lagi punya halaman login atau history", async () => {
    const appDirs = await readdir(path.join(webRoot, "app"), { withFileTypes: true });
    const routes = appDirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    assert.ok(!routes.includes("login"), "app/login harus sudah dihapus");
    assert.ok(!routes.includes("history"), "app/history harus sudah dihapus");
    assert.equal(await readIfExists("lib/api-client.ts"), null, "klien API yang menunjuk tunnel mati harus hilang");
});

test("navbar tidak menautkan ke halaman yang sudah tidak ada", async () => {
    const navbar = await readFile(path.join(webRoot, "components", "Navbar.tsx"), "utf8");

    assert.doesNotMatch(navbar, /href="\/login"/);
    assert.doesNotMatch(navbar, /href="\/history"/);
});

test("tidak ada lagi URL tunnel sementara di sumber web", async () => {
    const files = await collectSourceFiles(path.join(webRoot, "app"))
        .then(async (appFiles) => appFiles.concat(await collectSourceFiles(path.join(webRoot, "components"))))
        .then(async (appFiles) => appFiles.concat(await collectSourceFiles(path.join(webRoot, "lib"))));

    for (const file of files) {
        const content = await readFile(file, "utf8");
        assert.doesNotMatch(
            content,
            /trycloudflare\.com/,
            `${path.relative(repoRoot, file)} masih menunjuk quick tunnel yang tidak stabil`,
        );
    }
});

test("versi yang ditampilkan berasal dari package.json, bukan angka yang ditulis tangan", async () => {
    const docsPage = await readFile(path.join(webRoot, "app", "docs", "page.tsx"), "utf8");
    const hero = await readFile(path.join(webRoot, "components", "Hero.tsx"), "utf8");
    const versionModule = await readFile(path.join(webRoot, "lib", "version.ts"), "utf8");
    const generator = await readFile(path.join(webRoot, "scripts", "generate-version.mjs"), "utf8");

    assert.match(generator, /\.\.\/"?\)?/, "generator harus membaca manifest di atas web/");
    assert.match(generator, /package\.json/);
    assert.match(versionModule, /version\.generated/, "halaman memakai nilai yang dibuat saat build");
    assert.doesNotMatch(docsPage, /Version:\s*\d+\.\d+\.\d+/, "jangan tulis nomor versi langsung di halaman");
    assert.match(docsPage, /WEB_VERSION/);
    assert.match(hero, /WEB_VERSION/);
});

test("deploy situs berjalan dari CI, bukan dari laptop", async () => {
    const workflow = await readFile(
        path.join(repoRoot, ".github", "workflows", "deploy-web.yml"),
        "utf8",
    );

    assert.match(workflow, /netlify-cli@latest deploy --prod/, "deploy harus lewat CLI Netlify");
    assert.match(workflow, /--no-build/, "artefak yang sudah diverifikasi yang dikirim, bukan build kedua");
    assert.match(workflow, /secrets\.NETLIFY_AUTH_TOKEN/);
    assert.match(workflow, /secrets\.NETLIFY_SITE_ID/);
    assert.match(workflow, /does not mention version/, "build harus gagal kalau versi tidak ikut terbit");
});

test("netlify mempublikasikan direktori export dan tidak memuat plugin server-render", async () => {
    const raw = await readFile(path.join(repoRoot, "netlify.toml"), "utf8");
    // Komentar menjelaskan kenapa plugin itu tidak dipakai, jadi yang diperiksa
    // hanya baris konfigurasi yang benar-benar dieksekusi.
    const config = raw
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");

    assert.match(config, /publish\s*=\s*"out"/, "static export menulis ke out/, bukan .next");
    assert.doesNotMatch(
        config,
        /@netlify\/plugin-nextjs/,
        "plugin nextjs mengharapkan .next dan hanya menambah cara build gagal",
    );
    assert.match(config, /base\s*=\s*"web"/);
});

async function collectSourceFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectSourceFiles(full)));
        } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
            files.push(full);
        }
    }
    return files;
}
