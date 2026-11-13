# DevWorkflow Android Companion — As-Is Architecture Audit (M0 Baseline)

**Document Reference:** `DEVWF-MOB-AUDIT-001`  
**Evaluation Date:** 2026-11-12  
**Target Device Baseline:** Xiaomi Pad 6 (Android 14/15, API 34/35, 2880×1800, Landscape)  
**Status:** COMPLETE (M0 Architectural Gate)  

---

## 1. Executive Summary

The DevWorkflow Android Companion is an existing, functional mobile client located in `mobile-app/`. It was created specifically to eliminate browser tab bloat on tablet devices (which accumulated up to 23 chrome instances during test runs) and to serve as a dedicated landscape desk cockpit monitor for AI coding sessions.

The current implementation has already achieved:
- Standalone native release APK compilation (`android/app/build/outputs/apk/release/app-release.apk`, ~64 MB).
- Verified installation and runtime execution on physical **Xiaomi Pad 6** (SHA-256 binary parity verified with `adb pull`).
- Comprehensive regression testing with 28 automated tests in the main test runner and 6 mobile-specific unit tests (100% passing).

However, the application is currently tightly coupled to internal network configuration (hardcoded Tailscale IP `127.0.0.1:3100`), uses fixed 3-second HTTP polling, operates in read-only passive monitoring (with only an unauthenticated emergency session close endpoint), and lacks a secure dynamic pairing mechanism required for public open-source distribution.

---

## 2. Source Tree & Component Inventory

```
mobile-app/
├── App.js                   # Monolithic cockpit controller (1,307 LOC)
├── app.json                 # Expo SDK 58 configuration
├── package.json             # React 19.3.0, React Native 0.88.1, Expo 58.0.22
├── build-view.js            # Build state normalization and label rendering
├── flow-relation.js         # Zettly Draw thumbnail relation extractor & URL cache-buster
├── flow-relation.test.js    # Unit tests for flow thumbnail resolution
├── session-name.js          # Canonical session name humanizer
├── android/                 # Generated Expo prebuild Android Gradle project
│   ├── app/build.gradle     # Application Gradle config (package: com.programinglive.devwfmonitor)
│   ├── build.gradle         # Top-level build script (Gradle 8.x, JDK 17)
│   └── gradle.properties    # Hermes enabled, New Architecture enabled
└── assets/                  # Dark icons & splash (#0b0f14)
```

---

## 3. Detailed Component Breakdown

### 3.1. `App.js` (Core Application Lifecycle)
- **State Management:** React local hooks (`useState`, `useCallback`, `useEffect`, `useMemo`, `useRef`).
- **Layout & Grid:** Responsive 2-column landscape grid enabled when screen width ≥ `560dp` (`MIN_WIDTH_FOR_TWO_COLUMNS`). On Xiaomi Pad 6 (landscape width > 1200dp), renders two balanced columns of active session cards.
- **Server Clock Synchronization:** Adheres strictly to the architectural rule: *age labels (`ago()`) must use server time `now`, never local device time*. Guarded by `tests/monitor-clock-source.test.js` to prevent clock drift bugs observed in Android emulators.
- **Navigation Tabs:** 6 tabs in bottom navigation bar:
  1. `Aktif`: Live running agent sessions, live build cards, and recent event logs.
  2. `Build`: Dedicated build pipeline monitor with ETA p50/p90, host, and runner links.
  3. `Riwayat`: Completed/idle session history with status filtering (Semua, Selesai, Berjalan, Macet, Berakhir).
  4. `Rekap`: 7-day cumulative project duration aggregation.
  5. `Mesin`: Multi-machine inventory and parity checks (`build-host.example`, `HELLOWORLD`, `Mac`, `MMCH`).
  6. `Info`: Server address, connection metadata, and browser shortcut.
- **Detail Modal (`DetailSesi`):** Complete inspection modal displaying session title, project path, elapsed duration timer, full plan items, DoD items, and large Zettly Draw / Mermaid architecture diagram thumbnail.
- **Interactive Capabilities (Current State):**
  - Close Session: `POST /api/session/close` (sets phase to `closed`).
  - Share Session: `POST /api/share` (generates public share URL via Cloudflare tunnel).

### 3.2. Network & Communication Architecture
- **Protocol:** HTTP 1.1 Polling every 3,000 ms (`POLL_MS = 3000`).
- **Endpoint:** `GET /api/sessions` with 10-second `AbortController` timeout.
- **Security:** Cleartext HTTP allowed in Android Manifest (`usesCleartextTraffic: true`) to support Tailscale IP connectivity without TLS.
- **Failure Handling:** Displays visible alert banners for network disconnection (`galat`) and stale telemetry (`health.stale`).

### 3.3. Android Build Configuration
- **Package Name:** `com.programinglive.devwfmonitor`
- **Architecture:** React Native New Architecture enabled (`newArchEnabled: true`).
- **Engine:** Hermes JS Engine enabled.
- **Build Output:** Standalone release APK via `./gradlew assembleRelease`.
- **Target Device Status:** Verified on Xiaomi Pad 6 via ADB over Wi-Fi (`192.168.21.247:34497`).

---

## 4. Current Backend Monitor Server (`monitor-server/dashboard.cjs`)

The monitor server operates on port 3100 and exposes:
- `GET /api/sessions`: Returns active sessions, recent events, server clock `now`, machines, alerts, and summary.
- `GET /api/drawings/:id/thumbnail(.png)`: Renders server-side rasterized PNG for Mermaid/Zettly visual plans.
- `POST /api/session/close`: Closes a session by session key.
- `POST /api/share`: Creates authenticated share tokens.
- `GET /api/builds/report`: Aggregates build time distributions and p50/p90 calculations.

---

## 5. Existing Strengths
1. **Zero Browser Bloat:** Successfully solved Android intent tab explosion on desk tablets.
2. **Clock Truthfulness:** Uses server-driven timestamps to prevent stale or drifted duration metrics.
3. **High Information Density:** 2-column landscape layout fits active tasks, checklists, and build status on high-res displays without scrolling.
4. **Resilient Offline Notice:** Honest reporting when the monitor server is unreachable or reports are stale.
5. **Verified Hardware Execution:** Proven to run cleanly on Xiaomi Pad 6 without runtime crashes (`FATAL EXCEPTION: 0`).
