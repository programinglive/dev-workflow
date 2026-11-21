import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { auditSite } from "../audit/site-audit.js";
import { validateAuditUrl, fetchPage } from "../audit/fetch-page.js";
import { checkHeaders } from "../audit/checks/headers.js";
import { checkSeo } from "../audit/checks/seo.js";
import { checkA11y } from "../audit/checks/a11y-static.js";
import { parseArgs } from "../cli/args.js";
import { runCommand } from "../cli/commands.js";
import { handleToolCall } from "../tools/handlers.js";
import { getToolList } from "../tools/definitions.js";
import { createRequest } from "./test-helpers.js";

/**
 * Minimal PNG header. The audit only reads the IHDR width and height, so a
 * complete image is unnecessary and would make the fixture noisy.
 */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function htmlDocument({ lang, title, body }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="Fixture page for the site audit engine. It is long enough to satisfy the description check.">
<link rel="canonical" href="https://fixture.invalid/">
</head>
<body>${body}</body>
</html>`;
}

async function startFixture() {
  const png = pngHeader(512, 512);
  const big = "x".repeat(3 * 1024 * 1024);
  let base = "";

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://fixture.invalid").pathname;
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };

    if (pathname === "/") {
      send(
        200,
        "text/html; charset=utf-8",
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ProgramingLive test fixture</title>
<meta name="description" content="A fixture page used to prove the site audit checks without reaching the public internet.">
<link rel="canonical" href="${base}/">
<link rel="alternate" hreflang="en" href="${base}/">
<link rel="alternate" hreflang="id" href="${base}/id">
<meta property="og:title" content="ProgramingLive test fixture">
<meta property="og:description" content="A fixture page used to prove the site audit checks.">
<meta property="og:image" content="${base}/og.png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta name="twitter:card" content="summary">
</head>
<body>
<h1>Fixture</h1>
<img src="/og.png">
<input type="text" name="query">
<div id="duplicate"></div>
<div id="duplicate"></div>
<a href="/ok">ok</a>
<a href="/secure">secure</a>
<a href="/missing">missing</a>
<a href="/id">indonesian</a>
<a href="https://example.invalid/external">external</a>
</body>
</html>`,
        { "x-content-type-options": "nosniff" },
      );
      return;
    }

    if (pathname === "/ok") {
      send(
        200,
        "text/html; charset=utf-8",
        htmlDocument({
          lang: "en",
          title: "Healthy fixture page",
          body: '<h1>Healthy</h1><img src="/og.png" alt="Fixture cover"><a href="/">home</a>',
        }),
      );
      return;
    }

    if (pathname === "/id") {
      send(
        200,
        "text/html; charset=utf-8",
        htmlDocument({
          lang: "id",
          title: "Fixture page",
          body: '<h1>Fixture</h1><a href="/">beranda</a>',
        }),
      );
      return;
    }

    if (pathname === "/secure") {
      send(200, "text/html; charset=utf-8", htmlDocument({
        lang: "en",
        title: "Secure fixture page",
        body: '<h1>Secure</h1><a href="/">home</a>',
      }), {
        "content-security-policy": "default-src 'self'",
        "strict-transport-security": "max-age=31536000",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "geolocation=()",
        "x-content-type-options": "nosniff",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
      });
      return;
    }

    if (pathname === "/og.png") {
      send(200, "image/png", png);
      return;
    }

    if (pathname === "/sitemap.xml") {
      send(
        200,
        "application/xml",
        `<urlset><url><loc>${base}/</loc></url><url><loc>${base}/ok</loc></url></urlset>`,
      );
      return;
    }

    if (pathname === "/robots.txt") {
      send(200, "text/plain", `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
      return;
    }

    if (pathname === "/big") {
      send(200, "text/html; charset=utf-8", big);
      return;
    }

    if (pathname === "/slow-body") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<html><body>");
      res.on("error", () => {});
      setTimeout(() => {
        try {
          res.end("slow</body></html>");
        } catch {
          // The client already aborted, which is the behavior under test.
        }
      }, 400);
      return;
    }

    send(404, "text/html; charset=utf-8", "<html><body><h1>Not found</h1></body></html>");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;

  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("site_audit is registered as a read-only MCP tool with a required url", () => {
  const tool = getToolList().find((item) => item.name === "site_audit");
  assert.ok(tool, "site_audit must be registered");
  assert.deepEqual(tool.inputSchema.required, ["url"]);
  assert.match(tool.description, /read-only/i);
  assert.ok(tool.inputSchema.properties.checks);
  assert.ok(tool.inputSchema.properties.maxPages);
});

test("validateAuditUrl accepts http and https only and refuses credentials", () => {
  assert.equal(validateAuditUrl("https://example.com").hostname, "example.com");
  assert.throws(() => validateAuditUrl("ftp://example.com"), /http/i);
  assert.throws(() => validateAuditUrl("https://user:secret@example.com"), /credential/i);
  assert.throws(() => validateAuditUrl("not a url"), /url/i);
});

test("fetchPage truncates a body that exceeds the byte cap", async () => {
  const fixture = await startFixture();
  try {
    const page = await fetchPage(`${fixture.base}/big`, { maxBodyBytes: 1024 });
    assert.equal(page.ok, true);
    assert.equal(page.truncated, true);
    assert.ok(page.bytes <= 1024, `expected at most 1024 bytes, received ${page.bytes}`);
  } finally {
    await fixture.close();
  }
});

test("fetchPage applies the timeout to the body, not only the headers", async () => {
  const fixture = await startFixture();
  try {
    const page = await fetchPage(`${fixture.base}/slow-body`, { timeoutMs: 150 });
    assert.equal(page.ok, false);
    assert.match(page.error, /timed out/i);
  } finally {
    await fixture.close();
  }
});

test("checkSeo flags an unresolvable canonical instead of throwing", () => {
  const findings = checkSeo({
    page: {
      finalUrl: "https://example.com/",
      body: '<link rel="canonical" href="http://[invalid">',
    },
    origin: "https://example.com",
    robots: { status: 200 },
    sitemap: { status: 200, url: "https://example.com/sitemap.xml", urlCount: 1 },
  });
  assert.ok(findings.some((finding) => finding.id === "seo.canonical_invalid"));
});

test("checkA11y accepts implicit labels and still reports unnamed controls", () => {
  const document = (body) => ({
    finalUrl: "https://example.com/",
    body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Page</h1>${body}</body></html>`,
  });

  const implicit = checkA11y({
    page: document('<label>Search <input type="search" name="query"></label>'),
  });
  assert.ok(
    !implicit.some((finding) => finding.id === "a11y.input_label_missing"),
    "a control nested inside a label already has an accessible name",
  );

  const explicit = checkA11y({
    page: document('<label for="query">Search</label><input id="query" name="query">'),
  });
  assert.ok(!explicit.some((finding) => finding.id === "a11y.input_label_missing"));

  const unnamed = checkA11y({ page: document('<input name="query">') });
  assert.ok(unnamed.some((finding) => finding.id === "a11y.input_label_missing"));
});

test("checkHeaders reports missing security headers and accepts a complete set", () => {
  const missing = checkHeaders({ url: "https://example.com/", headers: {} });
  const ids = missing.map((finding) => finding.id);
  assert.ok(ids.includes("headers.csp_missing"));
  assert.ok(ids.includes("headers.frame_protection_missing"));
  assert.ok(ids.includes("headers.referrer_policy_missing"));
  assert.ok(ids.includes("headers.permissions_policy_missing"));
  assert.ok(ids.includes("headers.x_content_type_options_missing"));

  const complete = checkHeaders({
    url: "https://example.com/",
    headers: {
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "strict-transport-security": "max-age=31536000",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "geolocation=()",
      "x-content-type-options": "nosniff",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
    },
  });
  assert.deepEqual(complete, []);
});

test("auditSite reports reachability, headers, seo, links, a11y and parity findings", async () => {
  const fixture = await startFixture();
  try {
    const report = await auditSite({ url: `${fixture.base}/`, maxPages: 10 });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.tool, "site_audit");
    assert.ok(report.summary.pagesScanned >= 3);
    assert.equal(report.summary.status, "fail");
    assert.ok(report.summary.errors > 0);
    assert.ok(report.categories.headers);
    assert.ok(report.categories.seo);

    const has = (id) => report.findings.some((finding) => finding.id === id);
    assert.ok(has("headers.csp_missing"), "expected a missing CSP finding");
    assert.ok(has("seo.og_image_dimensions"), "expected an og:image dimension finding");
    assert.ok(has("seo.twitter_card"), "expected a twitter card finding");
    assert.ok(has("links.broken_link"), "expected a broken link finding");
    assert.ok(has("a11y.image_alt_missing"), "expected a missing alt finding");
    assert.ok(has("a11y.duplicate_id"), "expected a duplicate id finding");
    assert.ok(has("a11y.input_label_missing"), "expected a missing input label finding");
    assert.ok(has("parity.route_missing"), "expected a missing parity route finding");

    const broken = report.findings.find((finding) => finding.id === "links.broken_link");
    assert.match(broken.url, /\/missing$/);
    assert.equal(typeof broken.remediation, "string");
    assert.ok(broken.remediation.length > 10);
  } finally {
    await fixture.close();
  }
});

test("devwf audit --json returns the same structured report as the engine", async () => {
  const fixture = await startFixture();
  try {
    const out = { lines: [], write(line) { this.lines.push(line); } };
    const args = parseArgs([
      "audit",
      "--url",
      `${fixture.base}/`,
      "--json",
      "--checks",
      "headers,seo",
    ]);
    const result = await runCommand({ args, env: {}, out });

    assert.equal(result.ok, false, "a missing CSP header must fail the default threshold");
    const payload = JSON.parse(out.lines.join("\n"));
    assert.equal(payload.tool, "site_audit");
    assert.equal(payload.schemaVersion, 1);
    assert.ok(payload.findings.some((finding) => finding.id === "headers.csp_missing"));
  } finally {
    await fixture.close();
  }
});

test("devwf audit refuses an invalid url with exit code 2", async () => {
  const out = { lines: [], write(line) { this.lines.push(line); } };
  const args = parseArgs(["audit", "--url", "ftp://example.com"]);
  await assert.rejects(() => runCommand({ args, env: {}, out }), (error) => {
    assert.equal(error.exitCode, 2);
    return true;
  });
});

test("the site_audit MCP handler returns the same JSON report", async () => {
  const fixture = await startFixture();
  try {
    const response = await handleToolCall({
      request: createRequest("site_audit", { url: `${fixture.base}/`, checks: ["headers"] }),
      normalizeRequestArgs: (input) => ({ args: input, error: null }),
      workflowState: null,
      exec: async () => ({ stdout: "" }),
      git: {},
      utils: {},
    });

    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, "site_audit");
    assert.ok(payload.findings.some((finding) => finding.id === "headers.csp_missing"));
  } finally {
    await fixture.close();
  }
});
