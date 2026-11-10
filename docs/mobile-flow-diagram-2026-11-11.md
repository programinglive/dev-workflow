# Mermaid flow on the Android monitor (2026-11-11)

## Problem

The browser dashboard showed the Zettly Draw flow for every session, but the
Android app on the Xiaomi Pad 6 showed nothing. The owner could not see the plan
from the device he actually carries.

## Root cause

Two independent gaps:

1. **The app never read the relation.** `App.js` rendered the task, project,
   plan and build, but ignored `task_relations_json`, so the `zettly_draw`
   relation was dropped on the floor.
2. **The thumbnail is SVG.** `/api/drawings/:id/thumbnail` returns
   `image/svg+xml`. React Native's `<Image>` cannot draw SVG, so even after
   wiring the relation the image stayed blank. Measured on the tablet: the flow
   area was 100% one colour (`#0b1020`).

## Fix

- `mobile-app/flow-relation.js` — `relasiFlow()` finds the `zettly_draw`
  relation, `punyaTask()` decides whether a missing flow is worth warning about,
  and `urlThumbnail()` builds the raster URL.
- `mobile-app/App.js` — the session card shows the flow thumbnail; the detail
  modal shows a larger copy plus a link to the Zettly drawing. A session with a
  task but no drawing now says `📐 Flow belum ada - jalankan create_feature_flow`
  instead of staying silent.
- `monitor.cjs` on `bw-tools` — new route
  `/api/drawings/:id/thumbnail.png` rasterises the stored SVG with `sharp` and
  caches the result in memory (max 200 entries). The SVG route is unchanged.

## Evidence

- `node --test mobile-app/flow-relation.test.js` → 5/5 pass.
- APK rebuilt on HELLOWORLD (`BUILD SUCCESSFUL`), installed on the Xiaomi Pad 6
  (`23043RP34G`, `100.81.240.34:35405`).
- Screenshot analysis of the flow area: 430 distinct colours and all SVG accent
  colours present (blue `#60a5fa`, amber `#f59e0b`, purple `#a78bfa`, green
  `#22c55e`, white text). Before the fix the same area had 1 colour.
- `GET /api/drawings/159/thumbnail.png` → `200 image/png` (166 KB).

## Rollback

- App: revert `mobile-app/App.js` and delete `flow-relation.js`; the previous
  APK is still installable.
- Monitor: restore the newest
  `/opt/devwf-monitor/monitor.cjs.bak-png-*` backup and restart
  `devwf-monitor`.

## Note on drift

`/opt/devwf-monitor` is not a git repository, so the PNG route lives only on
`bw-tools`. A backup is written next to the file before every patch. If the
monitor is ever redeployed from a source tree, this route must be carried over.
