# Release Notes

Authoritative history of user-visible changes for the Development Workflow MCP Server. Each entry highlights the improvements that shipped with the tagged version.

| Version | Date | Notes |
|---------|------|-------|
| 3.2.0 | 2026-11-25 | **breaking:** Sentry preemption gate off by default, auto-resolve opt-in, new confirmed `set_sentry_issue_status` tool (66 in full). |
| 3.1.5 | 2026-11-25 | **packaging:** exclude runtime `state/` and generated `user-id` from the npm tarball and gate publishing on the packaging dry-run test. |
| 3.1.4 | 2026-11-25 | **security/tooling:** exempt GitHub OIDC permission declarations from the secret scanner, forward the macOS mutex opt-in to the bundle verifier, and skip device restarts when no AI session is live. |
| 1.31.0 | 2026-11-12 | **architecture:** complete Milestone 0 audit and Zettly integration contract v1 (dbb3cfc) |
| 1.26.0 | 2026-11-08 | **release:** merge origin/main into the monitor reconciliation line (4f37770): start-task now shows which tasks other sessions hold before choosing (#63), managed-rules build-host.example fix; restores a forward-only central release pointer that also contains the unified card-chain monitor of v1.25.0 (56992e9) |
| 1.25.0 | 2026-11-08 | **monitor:** merge origin/main monitor truth fixes (PR #59) into the unified card-chain upsert; assignWorkflowIdentity is the single parentTask writer (0a414bb) |
| 1.24.2 | 2026-11-08 | **monitor:** unify task-metadata and card-chain models into one upsert and dashboard (6b3a0f8) |
| 1.12.3 | 2026-10-28 | **release:** catat rilis 1.12.2 (5c67101) |
| 1.12.2 | 2026-10-28 | **release:** catat rilis 1.12.1 (3beaa23) |
| 1.12.1 | 2026-10-28 | **release:** catat rilis 1.12.0 (bb8624b) |
| 1.12.0 | 2026-10-28 | See CHANGELOG for details. |
| 1.11.0 | 2026-10-28 | See CHANGELOG for details. |
| 1.10.0 | 2026-10-28 | See CHANGELOG for details. |
| 1.9.1 | 2026-01-29 | **workflow:** add mermaid diagram and fix high severity tar vulnerability (32b47fa) |
| 1.9.0 | 2026-01-29 | See CHANGELOG for details. |
| 1.8.1 | 2025-12-26 | add release notes for v1.8.0 (5a4025b) |
| 1.8.0 | 2025-12-27 | See CHANGELOG for details. |
| 1.7.17 | 2025-12-26 | update release notes for v1.7.16 (0afd96b) |
| 1.7.16 | 2025-12-24 | align database schema with dashboard and improve user ID handling (69e7f38) |
| 1.7.15 | 2025-12-19 | optimize startup performance and add database connection resilience (bff2714) |
| 1.7.14 | 2025-12-19 | add API dependencies and update login to use API client (94bb42f) |
| 1.7.13 | 2025-12-18 | remote db connection, history api 500 errors, and windows startup (ce559a6) |
| 1.7.12 | 2025-12-17 | post-release cleanup v1.7.11 (c2ee733) |
| 1.7.11 | 2025-12-17 | test: comprehensive DB adapter tests, env support, and warning fixes (64b029a) |
| 1.7.10 | 2025-12-16 | update release notes and finalize ci config (92ac78a) |
| 1.7.9 | 2025-12-16 | **ci:** apply official npm trusted publishing config (9256583) |
| 1.7.8 | 2025-12-16 | **ci:** remove all token config for pure OIDC publishing (d4759cc) |
| 1.7.7 | 2025-12-16 | **ci:** remove duplicates and apply robust trusted publishing config (eedb661) |
| 1.7.6 | 2025-12-16 | **ci:** restore registry config with token fallback for Trusted Publishing (542615c) |
| 1.7.5 | 2025-12-16 | **ci:** switch to tokenless trusted publishing (fdfc4a9) |
| 1.7.4 | 2025-12-16 | **ci:** add id-token permission for npm provenance (8930338) |
| 1.7.3 | 2025-12-16 | **ci:** add web dependencies installation step (7d5dc62) |
| 1.7.2 | 2025-12-16 | **ci:** consolidate release and publish workflows (98e5b31) |
| 1.7.1 | 2025-12-16 | build errors and warnings (dc24831) |
| 1.7.0 | 2025-12-16 | See CHANGELOG for details. |
| 1.6.3 | 2025-12-06 | update release notes for 1.6.2 (f0c2d49) |
| 1.6.2 | 2025-12-06 | update release notest for 1.6.1 (72a9284) |
| 1.6.1 | 2025-12-06 | add table header to release notes for release script compatibility (44e47fc) |

































## 1.31.0

Released on **2026-11-12**.

- **architecture:** complete Milestone 0 audit and Zettly integration contract v1 (dbb3cfc)
- **opensource:** complete security discovery, extraction strategy, and release checklist (3c0d1d9)
- update README with unified 3-plane architecture, Zettly separation, and mobile cockpit (55949bc)
- **fleet:** implement Addendum #5 automated fleet update manager and tool sync (9974148)
- **fleet:** implement Addendum #6-#8 universal providers, resume, and upgrade CLI (b836c77)
- **mobile:** add IdentityProvider, gateway policy, and Xiaomi Pad 6 M4 UX (f268cdd)
- **mobile:** complete M5-M7 HITL governance, evidence inspector, and Option B+ gate (9f9e43f)
- **mobile:** document M0 architecture audit, gap analysis, and Xiaomi Pad 6 specs (6dab7fe)
- **mobile:** implement M1 runtime server configuration and profile switcher (224d47c)
- **mobile:** upgrade commiter to ^1.5.1 and apply DW Android Companion icon and splash (dd3aa1e)
- **release:** complete Option B+ phase 3 readiness, detail fix, and web DW badge (b56a22b)
- **fleet:** add v1.31.0 real session resume verification and release report (58b62e7)
- update cli/args.js, cli/commands.js, docs/mobile-app.md +11 more (392df2b)
- update docs/mobile-app.md, mobile-app/App.js, mobile-app/connection-manager.js +6 more (6e2beff)
- **mobile:** resolve App.js JSX syntax and record Option B+ Canary verification (0649de6)
- **monitor:** replace PAGE version interpolation with runtime token replacement (7972b53)

## 1.12.3 – 📝 Documentation

Released on **2026-10-28**.

- **release:** catat rilis 1.12.2 (5c67101)
- **factory:** kirim alasan pada move_task agar task bisa ditutup (88f6b48)

## 1.12.2 – 📝 Documentation

Released on **2026-10-28**.

- **release:** catat rilis 1.12.1 (3beaa23)
- **state:** ambil identitas sesi dari request metadata, bukan env (f879938)

## 1.12.1 – 📝 Documentation

Released on **2026-10-28**.

- **release:** catat rilis 1.12.0 (bb8624b)
- **state:** tentukan projectRoot dari letak .state, bukan jumlah dirname (7ba5755)
- **release:** catat rilis 1.11.0 (44d6657)
- **state:** pisahkan state workflow per sesi, history tetap milik proyek (f6da2a6)
- **release:** catat rilis 1.10.0 (a57dba4)
- **mcp:** laporkan pengambil alihan dan rapikan pesan penolakan (02b9e33)
- **mcp:** heartbeat otomatis dan identitas perangkat bersama CLI (11e73e0)
- **license:** make Clinic proprietary and refresh README (7cd2bda)
- run MySQL and PostgreSQL adapters against real servers (#31) (9b6aaef)
- build releases on MMCH, publish on a hosted runner (#9) (e975796), closes #7
- publish without provenance while the repo stays private (#12) (6dbc16f)
- run tests on the self-hosted MMCH runner (#7) (ad296f1)
- verify the built bundle actually starts (#44) (dbaa2a8)
- **ci:** add dependabot configuration (#15) (80ca440)
- **ci:** bump actions/checkout from 4 to 7 (#16) (cea2089)
- **ci:** bump actions/download-artifact from 4 to 8 (#18) (a957d40)
- **ci:** bump actions/github-script from 7 to 9 (#17) (1cdeda5)
- **ci:** bump actions/setup-node from 4 to 7 (#19) (d147a9e)
- **ci:** bump actions/upload-artifact from 4 to 7 (#20) (01f4902)
- **ci:** keep tailwind on v3 and stop dependabot proposing v4 (#46) (71193a7)
- **deps)(deps:** bump the minor-and-patch group with 5 updates (#21) (65be648)
- **deps:** bump commitlint to 21 and align config-conventional (#32) (df59f39)
- **deps:** bump dotenv to 18 (#41) (b8ee057)
- **deps:** bump typescript to 7 (#33) (0b292fc)
- **deps:** drop root dependencies that only the dashboard uses (#34) (cf2a529)
- regenerate package-lock.json to fix ECOMPROMISED error (83c9ba0)
- **web-deps)(deps:** bump dotenv from 17.2.3 to 18.0.9 in /web (#27) (baa2d5c)
- **web-deps)(deps:** bump the minor-and-patch group (#26) (9deefc1)
- **web-deps:** bump @types/node to 26 in web (#42) (0f4f5e2)
- **web-deps:** bump eslint to 10 and fix the lint script (#39) (6477024)
- **web-deps:** bump lucide-react to 1.x and replace the removed Github icon (#40) (a4db628)
- **web-deps:** bump typescript to 7 in web and migrate import assertions (#43) (3e00a26)
- **web:** update version to 1.9.1 (6b0eb38)
- **build:** keep dotenv external so the bundle can start (#45) (d889c8f)
- **ci:** do not fail release when the bundle exits after stdin closes (#10) (033ea9a)
- **ci:** use Node 24 in the publish job so npm@latest can install (#11) (283b7d5)
- clear remaining devDependency advisories (#5) (97deb5f)
- repair stale test assertions and clear production audit (#4) (b018012)
- **scripts:** make stack setup work on OpenCode V2 (#3) (a2a1618)
- **state:** stop losing in-progress work when workflow state is shared between sessions (3cb34f1)
- **web:** clear dashboard advisories and add CI coverage (#8) (790e551)
- add AGENTS.md enforcement rules and auto-creation during stack setup (08633a6)
- add remote bootstrap scripts for Windows (HELLOWORLD) and macOS (Mac) (4bb5db5)
- add Software Factory architecture docs and API endpoints for factory.programinglive.com (fde59aa)
- add unified setup script for AI Agent Development Stack (Workflow + Superpowers + RTK) (6c9a0a8)
- **factory:** izinkan agen menandai task selesai (approve) dari sync_task_status (38e7343)
- **factory:** read and update your Factory task queue from MCP (#14) (482ef5a)
- **factory:** tambah create_factory_task dan list_factory_projects (1c5ed69)
- **factory:** wire MCP to the real Factory API instead of PocketBase activity_tasks (fa841c6)
- **mcp:** kirim alasan takeover dan ekspos respons 409 Factory (caf1c30)
- **mcp:** kirim identitas sesi editor, dan izinkan status done (58929f1)
- **mcp:** takeover task milik perangkat lain lewat alasan (d35c777)
- **web:** add mermaid visual planning to landing page (519868e)
- **mcp:** dokumentasikan parameter takeoverReason (6e96422)
- rewrite README in English and correct stale claims (#13) (d88951b)
- rewrite README with quickstart guide, add homelab docs, fix Windows path tests (f6f4910)
- **web:** add mermaid feature flow to documentation (83ab683)

## 1.12.0

Released on **2026-10-28**.

- See CHANGELOG for details.

## 1.11.0

Released on **2026-10-28**.

- See CHANGELOG for details.

## 1.10.0

Released on **2026-10-28**.

- See CHANGELOG for details.

## 1.9.1 – ✨ Features

Released on **2026-01-29**.

- **workflow:** add mermaid diagram and fix high severity tar vulnerability (32b47fa)
- record release notes for v1.8.1 (fd213dd)
- **web:** sync version badges with package metadata (b579113)
- **workflow:** integrate mermaid feature flow and stabilize workflow logic (88dfe56)
- update commitlint dependencies and setup commiter (6e016f9)

## 1.9.0

Released on **2026-01-29**.

- See CHANGELOG for details.

## 1.8.1 – 📝 Documentation

Released on **2025-12-26**.

- add release notes for v1.8.0 (5a4025b)
- refresh PRD and README for v1.8.0 (d7ff89e)
- complete handlers.js modularization and fix all tests (af5b3d6)
- split handlers.test.js into smaller focused test modules (321bbe5)

## 1.8.0

Released on **2025-12-27**.

- See CHANGELOG for details.

## 1.7.17 – 📝 Documentation

Released on **2025-12-26**.

- update release notes for v1.7.16 (0afd96b)
- allow skipping release step (004e4fa)
- add @programinglive/commiter setup (1d2a19d)

## 1.7.16 – 🐛 Bug Fixes

Released on **2025-12-24**.

- align database schema with dashboard and improve user ID handling (69e7f38)
- cleanup temporary debugging scripts (a5e2b15)
- sync version to 1.7.15 across web and landing pages (c520e4a)
- update macOS MCP config instructions (1e368da)

## 1.7.15 – 🐛 Bug Fixes

Released on **2025-12-19**.

- optimize startup performance and add database connection resilience (bff2714)
- refactor Navbar and History to use absolute API client URLs v1.7.18 (dc33eae)
- sync all version labels to 1.7.14 and improve netlify routing (78712eb)
- sync all version strings to 1.7.14 (e2a1795)
- sync version to 1.7.14 and fix static routing via trailingSlash (1c152bd)

## 1.7.14 – ✨ Features

Released on **2025-12-19**.

- add API dependencies and update login to use API client (94bb42f)
- add REST API server for frontend database access (cdb347c)
- implement JWT authentication and update client (8efbe80)
- remove session cookies, enforce JWT only (bacd83a)
- add credentials:include to getCurrentUser to persist session (b8f2df5)
- add root netlify.toml for monorepo support (54c5ed3)
- enable trust proxy and force secure cookies for cross-domain session (2c5d6e8)
- ensure getMe uses full API URL (b3bd0da)
- force API URL to tunnel address to resolve cached old IP (1883731)
- inline auth functions in API server (eefd73c)
- remove duplicate variable declarations in API server (31d3621)
- remove dynamic API route for static export (05a4dd0)
- remove explicit publish path to fix netlify build (cd64bcf)
- remove incorrect netlify publish dir for dynamic build (ea34cf4)
- remove incorrect publish dir from netlify config (010236f)
- restore static export for netlify deployment (685d841)
- update API URL to use Cloudflare Tunnel for HTTPS (ab72f6c)
- use apiClient in history page and add version indicator (4889669)
- use npm install instead of ci to avoid lockfile issues (e5fae26)
- bump version to 1.7.14 to ensure fresh build (f7d8886)
- bump version to 1.7.15 for JWT frontend deploy (7850268)
- cleanup post-release and update website version to 1.7.13 (7341d44)
- save pending changes before release (4d4b1c9)

## 1.7.13 – 🐛 Bug Fixes

Released on **2025-12-18**.

- remote db connection, history api 500 errors, and windows startup (ce559a6)

## 1.7.12 – 📝 Documentation

Released on **2025-12-17**.

- post-release cleanup v1.7.11 (c2ee733)
- add authentication system with login page and protected routes (2acb20e)
- add Docker deployment support with PostgreSQL for GCP (3adb4cb)
- expose PostgreSQL port for remote access (b1d4066)
- revamp history page UI and remove history from landing (a9d0e4e)
- simplify docker-compose to only PostgreSQL, improve logout button UI (4530862)
- suppress 401 auth errors in console (b63e63b)
- **web:** resolve 500 error on history API and auth sync (88bbff0)
- configure commitlint and husky via commiter setup (4de6c84)
- update website to v1.7.11 and fix dependencies (da80b1c)

## 1.7.11 – 📝 Documentation

Released on **2025-12-16**.

- fix version status in PRD (fa7912b)
- implement .env support and fix mysql date persistence (096797c)
## 1.7.11 – 📝 Documentation & 🧪 Testing

Released on **2025-12-17**.

- test: comprehensive DB adapter tests for MySQL, PostgreSQL, and SQLite (64b029a)
- test: implemented env support verification (64b029a)
- test: fixed deprecation warnings and missing mock exports (64b029a)
- docs: updated PRD and README with testing guide (64b029a)

## 1.7.10 – 🧹 Chores

Released on **2025-12-16**.

- update release notes and finalize ci config (92ac78a)
- update PRD and release notes for v1.7.9 (024b3c2)

## 1.7.9 – 🐛 Bug Fixes

Released on **2025-12-16**.

- **ci:** apply official npm trusted publishing config (9256583)
  - Fixed recurring ENEEDAUTH errors by adhering strictly to npm's Trusted Publishing documentation.
  - Configuration now includes `registry-url` in `setup-node` combined with `id-token: write` permission.
  - Ensures a seamless, tokenless release process via OIDC.

## 1.7.8 – 🐛 Bug Fixes

Released on **2025-12-16**.

- **ci:** remove all token config for pure OIDC publishing (d4759cc)

## 1.7.7 – 🐛 Bug Fixes

Released on **2025-12-16**.

- **ci:** remove duplicates and apply robust trusted publishing config (eedb661)

## 1.7.6 – 🐛 Bug Fixes

Released on **2025-12-16**.

- **ci:** restore registry config with token fallback for Trusted Publishing (542615c)

## 1.7.5 – 🐛 Bug Fixes

Released on **2025-12-16**.

- **ci:** switch to tokenless trusted publishing (fdfc4a9)

## 1.7.4 – 🐛 Bug Fixes

Released on **2025-12-16**.

- **ci:** add id-token permission for npm provenance (8930338)

## 1.7.3 – 🐛 Bug Fixes

Released on **2025-12-16**.

- **ci:** add web dependencies installation step (7d5dc62)

## 1.7.2 – 🐛 Bug Fixes

Released on **2025-12-16**.

- **ci:** consolidate release and publish workflows (98e5b31)

## 1.7.1 – 🐛 Bug Fixes

Released on **2025-12-16**.

- build errors and warnings (dc24831)
- suppress remaining build warnings (f7d9b2d)
- handle null CustPL in birthday-customers.blade.php (ERP-19) (71b8f7e)
- integrate database adapters into workflow state (370cbb4)
- update PRD and add configuration guide (1dfccf5)
- update release notes for 1.6.3 (afb9fb9)
- add mysql2 and pg dependencies (94423d7)
- **release:** null 🚀 (93a17e2)
- **release:** null 🚀 (033097e)
- **release:** null 🚀 (91c800a)
- **release:** null 🚀 (f0958c4)
- **release:** null 🚀 (ac3cc6e)
- **release:** null 🚀 (f3f9a00)
- **release:** null 🚀 (bcf7d95)
- **release:** null 🚀 (74df6d6)
- **release:** null 🚀 (0d9dc4d)
- **release:** null 🚀 (9667012)
- **release:** null 🚀 (db25d0c)
- **release:** null 🚀 (50d5353)
- **release:** null 🚀 (ee0a540)
- **release:** null 🚀 (92558af)
- **release:** null 🚀 (cd851ac)
- **release:** null 🚀 (49ec562)
- **release:** null 🚀 (bcc7a3c)
- implement database adapters for sqlite, mysql, postgres (8e7416a)
- persist active workflow state to database (d29546d)

## 1.7.0

Released on **2025-12-16**.

- See CHANGELOG for details.

## 1.6.3 – 📝 Documentation

Released on **2025-12-06**.

- update release notes for 1.6.2 (f0c2d49)
- add light mode support to docs page (490cf22)

## 1.6.2 – 📝 Documentation

Released on **2025-12-06**.

- update release notest for 1.6.1 (72a9284)
- update create_documentation test to verify PRD check and remove incompatible jest test (a7f2b28)
- add PRD file existence check to create_documentation workflow step (62cdee3)
- add PRD file existence check to create_documentation workflow step (6c51012)

## 1.6.1 – 🐛 Bug Fixes

Released on **2025-12-06**.

- add table header to release notes for release script compatibility (44e47fc)
- add responsive vertical monitor support and dark/light mode toggle (5565765)

## Unreleased

## 1.5.11 — 2025-12-05
- See CHANGELOG for details.

## 1.5.10 — 2025-12-05
- See CHANGELOG for details.

## 1.5.9 — 2025-12-05
- See CHANGELOG for details.

## 1.5.8 — 2025-12-05 — 🐛 Bug Fixes
- **release:** amend tag to include release notes, remove build-docs.js and dist/docs (a3cea9b)

## 1.5.7 — 2025-12-05 — 🐛 Bug Fixes
- **ci:** checkout main branch for release notes and remove RELEASE_NOTES.html generation (5d50dc0)

## 1.5.6 — 2025-12-05 — 🐛 Bug Fixes
- **ci:** update github release workflow to use github-script (0990808)

## 1.5.5 — 2025-12-05 — 📝 Documentation
- add unreleased note for release automation (a5478dc)
- ensure GitHub release workflow writes release notes correctly

## 1.5.4 — 2025-12-05 — 🧹 Chores
- **ci:** add github release automation workflow (80d5ded)
- **release:** version 1.5.3 changes and changelog (c2698a7)
- run release scripts via cjs (bc241c8)
- **web:** update version display to 1.5.3 in docs page (25e37f3)
- **web:** update version display to 1.5.3 in Hero component (b478449)

## 1.5.3 — 2025-12-05 — 🐛 Bug Fixes
- correct package.json version from null to 1.5.2 for npm publish (be60c99)
- **news:** improve error handling and form accessibility (5e0a1a8)
- switch to static export for Netlify deployment (acddfd7)
- **release:** null 🚀 (55d7f99)
- **release:** prepare patch release 1.5.3 (5b92c42)

## 1.5.0 — 2025-12-02
- See CHANGELOG for details.

## 1.4.11 — 2025-12-01 — 🐛 Bug Fixes
- move vite to dependencies to ensure build works on production (62fc4c0)
- resolve sentry permission issues (c739f8e)

## 1.4.10 — 2025-12-01 — ✨ Features
- **dashboard:** implement random data generation for analytics chart (17e2073)
- move dompdf to require and resolve debugbar production error (e5d1cb6)

## 1.4.9 — 2025-11-30 — ♻️ Refactors
- **dashboard:** combine analytics charts and use local Chart.js (86ed3f4)

## 1.4.8 — 2025-11-30 — 🐛 Bug Fixes
- **dashboard:** improve responsive layout for admin stats cards (33d5b39)
- **dashboard:** improve responsive layout for admin stats cards (530400d)

## 1.4.7 — 2025-11-29 — ✨ Features
- add core doc types (PRD/README/RELEASE_NOTES) and fix CI build (8ed0567)
- update hero text and meta description to emphasize Indonesian programmer community (681547b)
- display dynamic version in web dashboard from /api/version (69f561d)
- add 1.4.3 release notes (8b165f7)
- add MCP registry metadata (mcpName & server.json) (66caea1)
- align MCP registry schema and docs (e4e732d)
- **release:** 1.4.4 🚀 (05a968f)
- **release:** 1.4.5 🚀 (7e823b9)
- **release:** 1.4.6 🚀 (7e0b672)

## 1.4.6 — 2025-11-27 — 🧹 Chores
- add MCP registry metadata (mcpName & server.json) (66caea1)

## 1.4.5 — 2025-11-27 — 🐛 Bug Fixes
- display dynamic version in web dashboard from /api/version (69f561d)

## 1.4.4 — 2025-11-27 — ♻️ Refactors
- consolidate workflow state to root .state folder only (3d69a14)
- ensure release guard uses freshest workflow state (e07eb42)
- remove invalid turbopack experimental config from next.config.ts (af0a7ea)
- **web:** configure next.js root to silence warnings (22ed002)
- **web:** improve mobile layout for hero section (53b26bf)
- add Plesk deployment guide (de35675)
- add 1.4.3 release notes (8b165f7)
- fix release state detection (ed5dfd1)
- prepare for release (a6ea2d0)
- **release:** 1.4.2 (fac8999)
- **release:** 1.4.2 🚀 (01b0b3c)
- **release:** 1.4.3 🚀 (04d8c3b)
- update task list (35663dd)
- **web:** fix next.js lockfile warning (05ffce0)
- add core doc types (PRD/README/RELEASE_NOTES) and fix CI build (8ed0567)
- update hero text and meta description to emphasize Indonesian programmer community (681547b)
- update program tracks and fix fast refresh warning (aa5bc9c)

## 1.4.3 — 2025-11-27 — 🧹 Chores
- **release:** 1.4.2 (fac8999)
- remove invalid turbopack experimental config from next.config.ts (af0a7ea)
- add Plesk deployment guide (de35675)
- update program tracks and fix fast refresh warning (aa5bc9c)

## 1.4.2 — 2025-11-27 — 🧹 Chores
- fix release state detection (ed5dfd1)
- prepare for release (a6ea2d0)
- update task list (35663dd)
- **web:** fix next.js lockfile warning (05ffce0)
- ensure release guard uses freshest workflow state (e07eb42)
- **web:** configure next.js root to silence warnings (22ed002)
- **web:** improve mobile layout for hero section (53b26bf)
- consolidate workflow state to root .state folder only (3d69a14)

## 1.4.1 — 2025-11-27 — 🐛 Bug Fixes
- update build test to include postbuild (b1e2f48)
- add custom server.js for Plesk (b3912cd)
- migrate dashboard to Next.js with TypeScript and Tailwind CSS (bce1fec)
- fix package.json scripts (fb25e98)
- fix tsconfig and remove dist artifact (282759f)

## 1.4.0 — 2025-11-26
- See CHANGELOG for details.

## 1.3.11 — 2025-11-23
- Re-applied Plesk security fix (moved static files to `web/public/`).
- Updated build configuration and server paths.

## 1.3.10 — 2025-11-23
- Fixed workflow state synchronization issue that caused forced releases.
- Added `docs/WORKFLOW-BEST-PRACTICES.md`.

## 1.3.9 — 2025-11-23
- Improved documentation modal layout and readability.

## 1.3.8 — 2025-11-23
- Fixed documentation loading in production by tracking `dist/docs` in git.

## 1.3.0 — 2025-11-22
- Added comprehensive Antigravity integration documentation and examples.
- Fixed Windows shell escaping for commit messages.
- Fixed release scripts to support ESM projects.
- Release guard now delegates to `@programinglive/commiter` and verifies the package is installed before running.

## 1.2.7 — 2025-11-13
- Delegated release process to `@programinglive/commiter`.

## 1.2.6 — 2025-11-11
- Exposed primary branch helper in CLI.
- Updated documentation regarding commiter delegation.

> **Notice:** Versions 1.2.2 through 1.2.5 were published briefly for packaging experiments and have been withdrawn.

## 1.2.1 — 2025-11-03
- Packaging touch-up; functionality remains identical to 1.2.0.

## 1.2.0 — 2025-11-03
- Reload the workflow state from disk for every tool call, preventing stale data when multiple clients manipulate the same project.

## 1.1.18 — 2025-11-03
- `commit_and_push` now auto-detects the primary branch (preferring `main`, then `master`) when none is supplied.

## 1.1.17 — 2025-10-31
- Release bookkeeping only; no user-facing changes.

## 1.1.16 — 2025-10-31
- Added npm provenance metadata so published packages include supply-chain attestations.

## 1.1.15 — 2025-10-31
- Documented the automated npm publish workflow and ensured CI builds include provenance before publishing.

## 1.1.14 — 2025-10-31
- Improved project-root detection for workflow state, fixing issues when the server runs from nested directories.

## 1.1.13 — 2025-10-30
- Version bump to distribute refreshed dashboard assets; no new functionality beyond 1.1.12.

## 1.1.12 — 2025-10-30
- Added a `node index.js call <tool>` CLI helper to invoke MCP tools without a client integration.
- Refreshed the web dashboard with a docs modal, dedicated docs API endpoints, and streamlined navigation.

## 1.1.11 — 2025-10-30
- Introduced per-user workflow state stored under `.state/users/<id>/` to avoid collisions on shared repos.
- Added a SQLite-backed project knowledge summary and the dashboard that visualizes history and trends.
- Hardened resumable workflows by re-checking persisted summaries between steps.

## 1.1.10 — 2025-10-29
- Shipped the initial project knowledge library with a persisted JSON summary for future database integrations.

## 1.1.9 — 2025-10-29
- Made `run_full_workflow` resume intelligently from the current phase.
- Expanded automated tests around README/exec updates and other workflow paths.

## 1.1.8 — 2025-10-27
- Documented the `DEV_WORKFLOW_STATE_FILE` override for relocating workflow state outside the repository.

## 1.1.7 — 2025-10-26
- Added prompts guiding developers to document changes immediately after tests pass.

## 1.1.6 — 2025-10-26
- Prevented `.state` from being created at filesystem roots.
- Enforced that commits must land before any release action can run.

## 1.1.5 — 2025-10-25
- Introduced the release guard, blocking `npm run release:*` until every prerequisite tool has run.
- Standardized per-project workflow state creation during installs.

## 1.1.4 — 2025-10-25
- Ensured the install script always targets the project root when initializing `.state`.

## 1.1.3 — 2025-10-25
- Packaged the MCP server for project-level installs with per-project workflow state isolation.

## 1.1.2 — 2025-10-25
- Version alignment release with no additional changes versus 1.1.1.

## 1.1.1 — 2025-10-25
- Added `force_complete_task`, letting teams close tasks early with an audit trail.

## 1.1.0 — 2025-10-25
- Added smart staging checks before commit, and made `continue_workflow` auto-run the next action in the commit phase.
- Enabled clean-tree commits to utilize `commit_and_push` and `perform_release` without manual staging.
- Clarified documentation for the commit/push step.

## 1.0.11 — 2025-10-25
- Added contextual "continue workflow" guidance describing the next recommended tool.
- Blocked releases until commits are safely pushed.

## 1.0.10 — 2025-10-24
- Modularized the workflow server internals for maintainability.
- Expanded automated tests around the release push flow.

## 1.0.9 — 2025-10-23
- Documented how local workflow state is managed across projects.

## 1.0.8 — 2025-10-21
- Added explicit workflows for skipping tests with justification and dropping tasks mid-flight.

## 1.0.7 — 2025-10-20
- Version alignment update; no new functionality recorded.

## 1.0.6 — 2025-10-20
- Strengthened release tests to ensure prerequisites are met before tagging.

## 1.0.5 — 2025-10-20
- Updated tests around `workflowState` persistence and validation.

## 1.0.4 — 2025-10-20
- Added an enforced release step after the ready check to ensure workflow order.
- Improved Windows compatibility by quoting commit messages safely.

## 1.0.3 — 2025-10-20
- Added a project `.gitignore` and clarified cross-platform installation steps.

## 1.0.2 — 2025-10-19
- Hardened `run_tests` argument validation and normalized tool call arguments.
- Expanded documentation around tool payload requirements.

## 1.0.1 — 2025-10-18
- Configured release tooling to support semantic version tagging moving forward.

## 1.0.0 — 2025-10-18
- Initial public release with the full MCP workflow (start → fix → tests → docs → commit → release → complete).
- Launched project governance, contribution guidelines, and tooling scaffolding.
