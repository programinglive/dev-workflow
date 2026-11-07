# Human-Readable Build Events & Monitor Activity UX Layout

**Date:** 2026-11-06  
**Status:** Completed  
**Branch:** `feat/human-readable-build-events-ui`

---

## 1. Problem Statement

When the `report_build_status` MCP tool reports a build lifecycle event (`build_started`, `build_progress`, `build_succeeded`, `build_failed`), it persists a JSON-serialized object into the `events.detail` column.

Previously:
1. **Raw JSON Ingestion in UI:** Both the web dashboard (`dashboard.cjs`) and mobile app (`mobile-app/App.js`) rendered `e.detail` as an escaped raw string, e.g.:
   ```text
   build_started {"status":"building","target":"Personal Voice Input Android APK","buildHost":"HELLOWORLD","command":"npm run tauri -- android build --apk","stage":"Compiling Tauri Android and whisper-rs","progress":100,"output":"Release binary compiled successfully in 5m 50s; live microphone and model download still require runtime checks.","startedAt":"2026-11-06T15:26:57.891Z","updatedAt":"2026-11-06T15:26:57.891Z","finishedAt":""} · personal-voice-input · 8m lalu
   ```
   This was difficult to read and made reviewing build outcomes tedious.
2. **Deep Scrolling Required:** The "Aktivitas & Build Log Terakhir" section was placed at the very bottom of the Active tab below all session cards (`#list`). When multiple active sessions with plans, checklists, and logs were active, users had to scroll through screens of content just to inspect recent build logs.

---

## 2. Solution & Architectural Changes

### A. Safe JSON Build Payload Extraction
Extracted and exported `parseEventDetail(detail)` in:
- `monitor-server/build-monitor.cjs` (re-exported via `build-monitor.js`)
- `mobile-app/build-view.js`

If the event detail is a JSON-encoded object with build properties (`target`, `status`, `stage`, `command`, `output`, `buildHost`), it parses into `{ isBuild: true, data: {...}, text: ... }`. Non-build and malformed strings safely degrade to `{ isBuild: false, data: null, text: str }`.

### B. High-Visibility UI Layout in Dashboard (`monitor-server/dashboard.cjs`)
1. **Elevated Placement:** Relocated the Activity & Build Log card above `#list` in the Active tab, giving instant visibility to recent build activity without vertical scrolling.
2. **Scrollable Viewport:** Wrapped the event list in `.events-scroll-container` with `max-height: 360px`, thin scrollbars, and overflow scrolling so it never displaces active session cards.
3. **Filtering & Collapse Controls:** Added quick filter chips (`Semua` and `Build saja`) and a collapse button (`Sembunyikan` / `Tampilkan`) with dynamic counter badges (`X aktivitas · Y build`).
4. **Structured Event Cards:**
   - Color-coded left borders and badges:
     - 🟢 `BERHASIL` (`#2ea043`)
     - 🟡 `BUILDING` / `TESTING` / `DEPLOYING` (`#d29922`)
     - 🔴 `GAGAL` (`#f85149`)
   - Prominent bold target headers (`Personal Voice Input Android APK`).
   - Executor host tags (`🖥️ HELLOWORLD`).
   - Stage indicators with percentage progress bars (`▸ Compiling Tauri Android and whisper-rs (100%)`).
   - Monospace command pills (`$ npm run tauri -- android build --apk`).
   - Formatted output quote boxes without JSON escaping quotes.

### C. Matching Mobile App Cards (`mobile-app/App.js`)
Updated the React Native monitor app on Xiaomi Mi Pad 6 / Android tablets:
- Integrated `parseEventDetail` into the home feed.
- Rendered structured build cards with colored border indicators, target labels, stage with progress bar, command snippets, and clean output boxes.
- Re-compiled Android release APK via Gradle 9.4.1 and streamed to Mi Pad 6.

---

## 3. Verification & Evidence

1. **Unit Tests:**
   - `tests/build-monitor.test.js`: Verified `parseEventDetail` handles plain text, JSON build payloads, malformed JSON, and nulls.
   - `tests/mobile-build-view.test.js`: Verified mobile parser parity.
   - Full test suite: 1,282 tests passed, 0 failed, 21 skipped.
2. **Live Android Release Build:**
   - Compiled release APK (`gradlew assembleRelease`) in 1m 25s.
   - Streamed to Xiaomi Mi Pad 6 via ADB Wi-Fi (`192.168.21.247:5555`).
   - Verified via `uiautomator dump` that the app runs and renders without errors.
