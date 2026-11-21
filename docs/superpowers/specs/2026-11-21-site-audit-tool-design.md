# Site Audit Tool Design

- Date: 2026-11-21
- Status: Approved
- Task: `77d6dcff-8a93-4e76-9e60-644b8a5f1c7f`
- Zettly Draw: <https://zettly.programinglive.com/draw/705>

## Purpose

Give dev-workflow a reusable, read-only way to audit a website so an agent can
find concrete improvement work without a browser, a cloud service, or a paid
API. The same headless engine backs a `devwf audit` CLI command and a
`site_audit` MCP tool, so a human and an agent see exactly the same report.

The first consumer is `programinglive.com`, but the capability is generic.

## Goals

1. One headless engine shared by the CLI and the MCP tool.
2. Zero new runtime dependencies. Node 20 global `fetch` only.
3. Deterministic, offline-testable checks.
4. A structured report with severity, per-category score, evidence, and
   remediation.
5. Bounded and safe: no writes, no form submission, no credentials, no
   unbounded crawl.

## Non-goals for v1

- Real Core Web Vitals, Lighthouse scores, screenshots, or browser rendering.
- axe-core accessibility results. The a11y check is explicitly labelled as a
  static heuristic.
- Automatic Zettly task creation, CI gating, or scheduled monitoring.
- Authenticated pages or pages behind a paywall.

These can be added later behind the check registry without changing the
architecture.

## Architecture

```text
devwf audit --url ...        site_audit MCP tool
          \                        /
           \                      /
            audit/site-audit.js (orchestrator)
                      |
          +-----------+-----------+
          |                       |
   audit/fetch-page.js     audit/crawl.js
          |                       |
          +-----------+-----------+
                      |
              audit/checks/*
                      |
               audit/report.js
                      |
            JSON report + human summary
```

### Module boundaries

- `audit/fetch-page.js` validates a URL and performs one bounded HTTP GET. It
  owns timeout, redirect tracking, body cap, charset decoding, and TTFB
  measurement.
- `audit/crawl.js` owns same-origin discovery: link extraction, URL
  normalization, `robots.txt`, concurrency, and page budget.
- `audit/checks/*.js` are pure functions over a page snapshot plus crawl
  context. They return findings, never mutate state.
- `audit/report.js` owns severity scoring and the human summary.
- `audit/site-audit.js` wires the parts and is the only public entry point.

## Check catalog (v1)

| Check | What it verifies | Typical severity |
| --- | --- | --- |
| `reachability` | status, redirect chain, TTFB, HTML size, compression, content type | error |
| `headers` | CSP, HSTS, frame protection, Referrer-Policy, Permissions-Policy, nosniff, COOP/CORP, version leaks | error / warn |
| `seo` | title, description, canonical, robots, hreflang, Open Graph, Twitter card, image dimensions, sitemap, robots.txt | warn |
| `links` | same-origin link status, 4xx/5xx, redirect loops | error |
| `a11y` | `lang`, one `h1`, image alt, form labels, link text, duplicate IDs, skip link, viewport | warn |
| `parity` | English and Indonesian route pairs exist | warn |

`perf` is an alias for the size and timing findings produced by
`reachability`; it is not a separate browser measurement.

The a11y form-label check accepts both explicit `for`/`id` labels and implicit
labels, where the control is nested inside the `<label>` element. Reporting the
latter as unlabelled was a false positive found during the first real audit.

## Report schema

```json
{
  "schemaVersion": 1,
  "tool": "site_audit",
  "requestedUrl": "https://example.com",
  "finalUrl": "https://example.com/",
  "startedAt": "2026-11-21T05:00:00.000Z",
  "durationMs": 1234,
  "summary": {
    "status": "warn",
    "score": 78,
    "errors": 1,
    "warnings": 4,
    "infos": 2,
    "pagesScanned": 8
  },
  "pages": [
    { "url": "https://example.com/", "status": 200, "ok": true, "ttfbMs": 120, "bytes": 83394 }
  ],
  "categories": {
    "headers": { "score": 60, "findings": [] }
  },
  "findings": [
    {
      "id": "headers.csp_missing",
      "category": "headers",
      "severity": "error",
      "title": "Content-Security-Policy is missing",
      "detail": "The response does not send a Content-Security-Policy header.",
      "remediation": "Define a CSP baseline in next.config.mjs and verify it in staging.",
      "url": "https://example.com/"
    }
  ]
}
```

Scoring: every category starts at 100. An error costs 25, a warning costs 8,
and an info costs 1, clamped to 0. The overall score is the rounded average of
the categories that ran. `status` is `fail` when any error exists, `warn` when
any warning exists, otherwise `pass`.

## CLI contract

```bash
devwf audit --url https://programinglive.com \
  --checks headers,seo,links,a11y,parity \
  --max-pages 8 --timeout 15000 --fail-on error [--json] [--out report.json]
```

- `--url` is required and must be `http` or `https`.
- `--checks` defaults to all checks.
- `--fail-on` is `error` (default), `warn`, or `none`.
- `--include-external` opts into checking external links, capped at 20.
- Exit codes: `0` when no finding reaches `--fail-on`, `1` when it does, `2`
  for invalid input.

## MCP contract

Tool name: `site_audit`. Read-only. No workflow state is read or written.

Input schema:

- `url` (string, required)
- `checks` (array of enum, optional)
- `maxPages` (integer 1-25, default 8)
- `timeoutMs` (integer 1000-60000, default 15000)
- `includeExternal` (boolean, default false)
- `parityPrefix` (string, optional, e.g. `/id`)

Output: the same JSON report as `--json`, serialized in a text response, matching
the `security_audit` precedent.

## Safety and limits

- Only `http` and `https`. URLs containing credentials are refused.
- Per-request timeout, maximum five redirects, 2 MB response cap.
- Crawl is same-origin by default, at most `maxPages`, concurrency 4.
- Only `GET` requests. No cookies, authorization headers, or form submission.
- Sensitive query parameters (`token`, `key`, `secret`, `password`) are redacted
  from reported URLs.
- No files are written unless `--out` is passed.

## Testing

- `tests/site-audit.test.js` starts a local `node:http` fixture server and
  covers every check, the URL validator, the body cap, the CLI command, and the
  MCP handler. No test reaches the public internet.
- Existing gates must stay green: `npm test`, `npm run lint`,
  `npm run check:english`, `npm run build:server`.
- `web/lib/catalog.generated.ts` is regenerated so the website catalog matches
  the new tool and CLI command.

## Rollout

1. Land the engine, CLI, MCP tool, tests, and docs on a feature branch.
2. Run the full verification gates.
3. Release through the repository release script.
4. Use the tool on `programinglive.com` in a separate task, then fix the
   highest-impact findings in that repository.

## Follow-ups (not in this task)

- Optional Lighthouse check behind `--checks lighthouse`.
- CI gate for the ProgramingLive repository.
- Automatic Zettly task creation from findings.
