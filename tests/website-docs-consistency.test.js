import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getToolList } from "../tools/definitions.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB_DIR = path.join(ROOT, "web");

const REQUIRED_PORTAL_SLUGS = [
  "getting-started",
  "cli",
  "mcp",
  "configuration",
  "architecture",
  "task-contracts",
  "storage",
  "fleet",
  "monitor",
  "security",
  "troubleshooting",
  "contributing",
];

function walkFiles(dir, exts = [".ts", ".tsx", ".js", ".mjs", ".css"]) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "out") continue;
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

test("website generated catalog matches runtime MCP definitions, CLI args, and package.json version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const catalogSrc = fs.readFileSync(path.join(WEB_DIR, "lib", "catalog.generated.ts"), "utf8");
  const jsonText = catalogSrc.replace(/^[\s\S]*?export const GENERATED_CATALOG =\s*/, "").replace(/\s+as const;\s*$/, "");
  const catalog = JSON.parse(jsonText);

  const runtimeTools = getToolList().map((t) => t.name).sort();
  assert.equal(catalog.version, pkg.version);
  assert.equal(catalog.mcpToolCount, runtimeTools.length);
  assert.deepEqual(
    catalog.mcpTools.map((t) => t.name),
    runtimeTools,
  );
  assert.equal(catalog.repositoryVisibility, "PUBLIC");
  assert.equal(catalog.npmPubliclyPublished, true);
  assert.equal(catalog.ossBaselineTag, "v1.31.0-oss.0");
  assert.ok(catalog.cli.commands.includes("doctor"));
  assert.ok(catalog.cli.commands.includes("fleet"));
  assert.ok(catalog.cli.fleetVerbs.includes("doctor"));
  assert.ok(catalog.cli.fleetVerbs.includes("status"));
  assert.ok(catalog.cli.fleetVerbs.includes("upgrade"));
});

test("website defines all required routes and 12 non-empty Developer Portal sections", () => {
  const requiredRoutes = [
    path.join(WEB_DIR, "app", "page.tsx"),
    path.join(WEB_DIR, "app", "docs", "page.tsx"),
    path.join(WEB_DIR, "app", "developers", "page.tsx"),
    path.join(WEB_DIR, "app", "developers", "[slug]", "page.tsx"),
    path.join(WEB_DIR, "app", "releases", "page.tsx"),
  ];
  for (const file of requiredRoutes) {
    assert.equal(fs.existsSync(file), true, `Missing route file: ${path.relative(ROOT, file)}`);
  }

  const portalSrc = fs.readFileSync(path.join(WEB_DIR, "lib", "portal-content.ts"), "utf8");
  for (const slug of REQUIRED_PORTAL_SLUGS) {
    assert.match(portalSrc, new RegExp(`slug:\\s*"${slug}"`), `Missing portal slug: ${slug}`);
  }
});

test("website source contains no retired Factory tools, private Tailscale IPs, or private workstation paths", () => {
  const files = [
    ...walkFiles(path.join(WEB_DIR, "app")),
    ...walkFiles(path.join(WEB_DIR, "components")),
    ...walkFiles(path.join(WEB_DIR, "lib")),
  ];

  const forbidden = [
    /claim_factory_task/,
    /list_factory_tasks/,
    /factory\.programinglive\.com/,
    /\b100\.(?:77|107)\.\d+\.\d+\b/,
    /C:[\\/]Users[\\/]DHIKA/i,
    /D:[\\/]code[\\/]/i,
    /\bHELLOWORLD\b/,
    /\bMMCH\b/,
    /migration-audit-record\.md/,
  ];

  const hits = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(content)) {
        hits.push(`${path.relative(ROOT, file)} matched ${pattern}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("web package.json wires normalize-static-export.mjs into postbuild", () => {
  const webPkg = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "package.json"), "utf8"));
  assert.equal(
    fs.existsSync(path.join(WEB_DIR, "scripts", "normalize-static-export.mjs")),
    true,
    "Missing web/scripts/normalize-static-export.mjs",
  );
  assert.match(String(webPkg.scripts?.postbuild || ""), /normalize-static-export\.mjs/);
});
