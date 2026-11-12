# DevWorkflow Android Companion — Xiaomi Pad 6 Optimization Specification

**Document Reference:** `DEVWF-MOB-HW-001`  
**Evaluation Date:** 2026-11-12  
**Hardware Profile:** Xiaomi Pad 6 (Model `23043RP34G`, Product `pipa_id`)  
**Operating System:** HyperOS / MIUI Android 14 (API 34)  

---

## 1. Hardware Characteristics & Target Environment

| Characteristic | Specification | Design Implication |
|---|---|---|
| **Display Size** | 11.0 inches IPS LCD | High viewing distance (desk stand, 40–70 cm away) |
| **Native Resolution** | 2880 × 1800 pixels (16:10 aspect ratio) | Extremely high PPI (309 ppi); requires scalable density units, never hardcoded pixels |
| **Refresh Rate** | Up to 144 Hz (Dynamic Adaptive) | Smooth scrolling and animations; avoid unthrottled 144 Hz re-rendering of activity streams |
| **Primary Orientation** | Landscape | Default layout locked to landscape; 2-column card grid |
| **Usage Pattern** | Dedicated Desk Cockpit | Always-on or prolonged screen-on time while coding |
| **Thermal & Battery** | 8840 mAh Battery, Snapdragon 870 | Fanless tablet; passive cooling requires minimal background CPU and throttled render loops |

---

## 2. Layout, Typography & Density Scaling

### 2.1. Responsive Landscape Density
- **Never Hardcode Physical Pixels:** Use device-independent density pixels (`dp`) or percentage units.
- **2-Column High-Density Grid:**
  - Breakpoint: `MIN_WIDTH_FOR_TWO_COLUMNS = 560dp`.
  - Xiaomi Pad 6 in landscape provides approx `1100–1200dp` effective width.
  - Active sessions are displayed in two balanced cards side-by-side with a 16dp gutter.
- **Desk Readability:**
  - Header Titles: `22–24sp` with high contrast (`#e6edf3`).
  - Active Task Title: `17–19sp` (bold, readable from 60 cm away).
  - Subtext & Metadata: `13–14sp` (`#8b949e` / `#7d8590`).
  - Timer: Monospace font (`14sp`, `#79c0ff`) with stopwatch glyph (`⏱ 01:24:12`).

### 2.2. Touch Target Standards
- Minimum touch target for all buttons and interactive chips: **48 × 48 dp**.
- Spacing between destructive actions (`Emergency Stop`) and dismiss actions: minimum **24 dp** separation with secondary confirmation modal.

---

## 3. Dedicated Desk Operation & Thermal Protection

### 3.1. Ambient Cockpit Dimming (Low-Activity Mode)
When running on a desk stand for 8+ hours:
1. **Inactivity Timer:** If no new agent events or touches occur within 5 minutes, the cockpit transitions to **Ambient Mode**:
   - Screen brightness dimmed to 30%.
   - Polling/Stream update frequency throttled from real-time to every 10 seconds.
   - Non-critical animations paused.
2. **Instant Wake on Event:** Any new agent state change (e.g. `tests_failed`, `ready_to_commit`, `build_started`) immediately restores full brightness and displays an attention banner.

### 3.2. Virtualized Activity Stream
- High-frequency agent tool calls (hundreds of reads/searches) can quickly overwhelm mobile memory if rendered as raw React Native `Text` nodes inside a `ScrollView`.
- **Optimization:** Use virtualized `FlatList` with `windowSize={5}`, `maxToRenderPerBatch={10}`, and a capped ring buffer (maximum 100 historical events in memory).

### 3.3. Thumbnail & Diagram Caching
- Visual architecture diagrams (Zettly Draw / Mermaid) can reach several megabytes in resolution.
- The thumbnail rasterizer serves high-DPI PNGs (`/api/drawings/:id/thumbnail.png`).
- Client caches images on disk using cache-busting tokens (`flow-relation.js`) tied to task launch IDs, avoiding redundant image downloads on every polling tick.

---

## 4. MIUI / HyperOS Specific ADB & Deployment Rules

As verified on 12 November 2026:
1. **Developer Options Bypass:** MIUI blocks adb installation by default with `INSTALL_FAILED_USER_RESTRICTED`.
2. **Mandatory Setting:**
   - `Settings → Additional settings → Developer options → Apps from unverified developers` must be toggled **ON** by the device owner using screen lock PIN.
3. **Verification Command:**
   ```bash
   adb -s 192.168.21.247:34497 install -r android/app/build/outputs/apk/release/app-release.apk
   ```
4. **Binary Parity Verification:**
   ```bash
   adb -s 192.168.21.247:34497 shell pm path com.programinglive.devwfmonitor
   adb -s 192.168.21.247:34497 pull <remote_path> /tmp/installed.apk
   sha256sum /tmp/installed.apk android/app/build/outputs/apk/release/app-release.apk
   ```
   Both SHA-256 hashes must be identical before claiming a successful deployment.
