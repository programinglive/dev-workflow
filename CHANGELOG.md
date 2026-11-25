# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## Unreleased (proposed 3.2.0)

### Breaking Behavior
* **preemption:** the Sentry preemption gate is now OFF by default and must be configured explicitly with `DEVWF_PREEMPTION_ENABLED`, `DEVWF_PREEMPTION_SENTRY_PROJECT`, `DEVWF_PREEMPTION_QUERY`, and `DEVWF_PREEMPTION_PROJECT_DIR_MARKERS`. Installations that relied on the previous always-on gate must set these variables to restore the old behavior. The override flag is now `allowPreemptionOverride`; the previous name remains a deprecated alias and prints a warning. This is a breaking change in default behavior, not a version bump.

### Bug Fixes
* **packaging:** exclude runtime `state/` and generated `user-id` files from the published npm tarball; `.npmignore` previously ignored only `.state/`, so a state root pointed at `<repo>/state` could leak a per-machine identifier into a release. Proposed release number for this fix alone: 3.1.5.

## [3.1.4](https://github.com/programinglive/dev-workflow/compare/v3.1.3...v3.1.4) (2026-11-25)

### 🐛 Bug Fixes

* **security:** treat GitHub Actions OIDC permission declarations as documentation instead of credentials, so history and summary projections no longer block `start_task`
* **tooling:** forward the explicit macOS mutex opt-in to the isolated bundle verifier so local build verification passes
* **chore:** ignore generated PocketBase databases so the commit gate cannot mistake them for source changes

## [3.1.3](https://github.com/programinglive/dev-workflow/compare/v3.1.2...v3.1.3) (2026-11-22)

### 🐛 Bug Fixes
* **ci:** use `node:module` `stripTypeScriptTypes` with CJS `typescript.transpileModule` fallback in `tests/opencode-guard-plugin.test.js` for Node 22.16 compatibility on the Linux CI runner.

## [3.1.2](https://github.com/programinglive/dev-workflow/compare/v3.1.1...v3.1.2) (2026-11-22)

### ✨ Features
* **release-governance:** implement Two-Stage Release Gate (`PRE_PUBLISH` and `POST_PUBLISH`) with Canonical Release State Model (`SOURCE_VERSION`, `GITHUB_RELEASE_VERSION`, `NPM_PUBLISHED_VERSION`, `NPM_LATEST_VERSION`, `WEBSITE_DEPLOYED_VERSION`, `RUNTIME_VERSION`) wired into `github-release.yml` and `deploy-web.yml`.
* **docs/web:** add Zettly Code v1.0 Debugging Journey to How to Use, add public [docs/guides/zettly-code-integration.md](docs/guides/zettly-code-integration.md), display `65 Canonical MCP Tools` & `Node 20+` in Homepage Hero, and clean up the last `audit_security` mention in `security_audit` description.

### 🐛 Bug Fixes
* **ci:** add Node 20/22.16 TypeScript transpile fallback in `tests/opencode-guard-plugin.test.js` so `Create GitHub Release` and `npm publish` pass 100% on the Linux runner (`Node v22.16.0`).

## [3.1.1](https://github.com/programinglive/dev-workflow/compare/v3.1.0...v3.1.1) (2026-11-22)

### 🐛 Bug Fixes
* **ci/build:** mark optional `@programinglive/zettly-code` external and silence expected `INEFFECTIVE_DYNAMIC_IMPORT` warnings in `vite.config.js` so `tests/build.test.js` and GitHub Release / npm publish pipelines pass cleanly.
* **docs:** scrub internal Tailscale IP literals from historical v2.1.3/v2.1.4 architecture reports so `tests/security-oss-public-surface.test.js` passes 100% on CI.
* **web:** synchronize onboarding journey, use-cases, and generated catalog to `v3.1.1` (`65` canonical tools) with zero remaining `2.1.1` references.

## [3.1.0](https://github.com/programinglive/dev-workflow/compare/v3.0.0...v3.1.0) (2026-11-22)

### ✨ Features
* **zettly-code:** integrate Zettly Code v1.0 persistent code memory and incremental SQLite knowledge graph via two canonical MCP tools (`code_index` and `code_context`), bringing the public catalog to 65 canonical tools with 0 compatibility aliases.
* **audit:** integrate `bugfix_knowledge` (`bugfix_knowledge_gate`) and `release_docs` (`release_docs_gate`) into canonical `audit` to enforce mandatory `@zettly-code` bug-fix knowledge comments and permanent open-source release documentation/website synchronization.
* **docs:** synchronize `README.md`, `CHANGELOG.md`, `AGENTS.md`, and website documentation (`web/lib/catalog.generated.ts`, `web/lib/how-to-use-data.ts`, `web/lib/use-cases-data.ts`) to v3.1.0 and remove outdated v2 tool references.

## [3.0.0](https://github.com/programinglive/dev-workflow/compare/v2.1.5...v3.0.0) (2026-11-22)

### ⚠ BREAKING CHANGES
* Radical MCP catalog simplification: reduced public MCP tools from 84 to 63 canonical tools with 0 compatibility aliases by consolidating 11 `audit_*` tools into `audit`, 12 `helper_*` tools into `analyze_change`/`plan_fix`/`apply_safe_fix`, and 3 `project_summary*` tools into `project_summary`.

## Unreleased

### 🐛 Bug Fixes

* **focus:** `complete_focus` no longer reports `FOCUS_TASK_SCAN_INCOMPLETE` on owners with more than 1000 Todos. Root cause: `linkedTasks` fetched the entire unfiltered Todo collection to find the tasks linked to a focus, and the bounded 1000-row safety guard correctly refused to decide on incomplete data. The focus-completion flow now reads the server-side filtered, owner-checked `GET /focus/{id}/board` endpoint, validates the returned rows, and keeps the old collection scan only as a fallback for Zettly servers that do not expose the board route.

### [1.33.1](https://github.com/programinglive/dev-workflow/compare/v1.33.0...v1.33.1) (2026-11-19)


### 📝 Documentation

* **ops:** correct CI runner references to bw-tools ([5a5295e](https://github.com/programinglive/dev-workflow/commit/5a5295ef8b3ba45a4397b168ab62f9ed8662d23e)), closes [#134](https://github.com/programinglive/dev-workflow/issues/134)


### 🐛 Bug Fixes

* **mcp:** keep heartbeat alive after worktree ownership loss ([#135](https://github.com/programinglive/dev-workflow/issues/135)) ([45fe022](https://github.com/programinglive/dev-workflow/commit/45fe0224dc5c8cc6aab6278c1600ffe7a71a3d1f))
* **security:** redact revoked Cloudflare Access token from consolidation report ([96f2676](https://github.com/programinglive/dev-workflow/commit/96f26764587daef5410f4669d3f52d9d4f746351))

## [1.33.0](https://github.com/programinglive/dev-workflow/compare/v1.32.8...v1.33.0) (2026-11-19)


### ⚠ BREAKING CHANGES

* fix CLI-First/orphan reset gates and rename package to @programinglive/dev-workflow

### 🐛 Bug Fixes

* **deps:** move vite to devDependencies and patch hono advisories ([2892231](https://github.com/programinglive/dev-workflow/commit/289223148206fb4a1712c801520f76f6174b843e))


### 🧹 Chores

* **web:** regenerate catalog after 1.32.8 release ([b781b58](https://github.com/programinglive/dev-workflow/commit/b781b583fc8d4f1801b15caa4c6d47415ac5704d))


### 📝 Documentation

* **managed:** replace single-focus exception with multiple concurrent focuses rule ([0e807ab](https://github.com/programinglive/dev-workflow/commit/0e807ab6fd4d1a7ed4e412c74796a3fc1f9fead2))
* **operations:** update execution journal with final outcome ([e98359e](https://github.com/programinglive/dev-workflow/commit/e98359e50e287b701fe87004beac9a04477918b6))


### ✨ Features

* fix CLI-First/orphan reset gates and rename package to @programinglive/dev-workflow ([a9fdea5](https://github.com/programinglive/dev-workflow/commit/a9fdea53f79a6707a53e169793f40f5acdae6bb8))

### [1.32.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.32.7...v1.32.8) (2026-11-18)


### ✨ Features

* **managed:** add fleet-status.cjs CLI to check MCP and toolchain parity ([3855c1a](https://github.com/programinglive/dev-workflow-mcp-server/commit/3855c1a9d9dea9d5676370862898158a7f45a953))

### [1.32.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.32.5...v1.32.7) (2026-11-18)


### 📝 Documentation

* **monitor:** drop retired Factory provenance wording ([893a2a1](https://github.com/programinglive/dev-workflow-mcp-server/commit/893a2a1409691a0bd30e5f4eb51f773868fd466b))
* **operations:** add Factory retirement and Next.js security execution journal ([6754086](https://github.com/programinglive/dev-workflow-mcp-server/commit/67540867c3c846d4395d44eafd2d768d48ca28b8))


### 🐛 Bug Fixes

* **web:** restore generated catalog removed by Factory cleanup ([f074335](https://github.com/programinglive/dev-workflow-mcp-server/commit/f074335280c54cf90a2dcf63d2cc22f998ef82b4))
* **workflow:** check recent commits for test evidence in commit_and_push ([79dd64d](https://github.com/programinglive/dev-workflow-mcp-server/commit/79dd64d07a8fd94fe77be23b5fc880b3d6afb5b0))


### 🧹 Chores

* **factory:** remove retired Factory integration from current main ([59cdad8](https://github.com/programinglive/dev-workflow-mcp-server/commit/59cdad83c8118b93000b8fff7d3f8233d179e68c))
* **release:** 1.32.6 🚀 ([9ff3627](https://github.com/programinglive/dev-workflow-mcp-server/commit/9ff3627206e9ea80692e279a335d79f3d375caf1))

### [1.32.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.32.5...v1.32.6) (2026-11-18)


### 🐛 Bug Fixes

* **workflow:** check recent commits for test evidence in commit_and_push ([0050176](https://github.com/programinglive/dev-workflow-mcp-server/commit/0050176a8e92fc76c3c37bae2a05aa47df8b6bdc))

### [1.32.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.32.4...v1.32.5) (2026-11-18)


### 🐛 Bug Fixes

* **managed:** fallback to prebuild-install for better-sqlite3 under npm 12 allowScripts ([22a5156](https://github.com/programinglive/dev-workflow-mcp-server/commit/22a51560f81f17f588f2b117401c2e81c111af06))

### [1.32.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.32.3...v1.32.4) (2026-11-18)


### ✨ Features

* **managed:** restore rollout/restart scripts and guard release against active CI pipelines ([7306678](https://github.com/programinglive/dev-workflow-mcp-server/commit/730667897cf6eed93dbfae4ad328b3090ce8a784))

### [1.32.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.32.0...v1.32.3) (2026-11-18)


### 📝 Documentation

* **restart:** record the verified relaunch mechanism per client ([#117](https://github.com/programinglive/dev-workflow-mcp-server/issues/117)) ([fa89b40](https://github.com/programinglive/dev-workflow-mcp-server/commit/fa89b40282fb47bcadc99d9d1549e50ed0302772))


### 🐛 Bug Fixes

* **fleet:** report real tool versions and target the approved release ([#124](https://github.com/programinglive/dev-workflow-mcp-server/issues/124)) ([18f5296](https://github.com/programinglive/dev-workflow-mcp-server/commit/18f5296f46ec6db2cb5c69094e924fa9f4dde0e4))
* **handover:** bind claims to the task, replace the successor row, reclaim dead locks ([9451910](https://github.com/programinglive/dev-workflow-mcp-server/commit/945191095fe35b45c3050c5de7d9b61844387216))
* **handover:** bind exit and claim identity to the owner, fence adoption ([f5330cb](https://github.com/programinglive/dev-workflow-mcp-server/commit/f5330cbf0835edbf56114f1bbf1b9f0fd89b59c3))
* **handover:** bind the snapshot, harden the lock, and persist the checkpoint ([ec6f4c4](https://github.com/programinglive/dev-workflow-mcp-server/commit/ec6f4c4d3b4281b84406d40073087b8fc15b3d38))
* **handover:** close recovery races and make adoption durable ([aca1b81](https://github.com/programinglive/dev-workflow-mcp-server/commit/aca1b8174fe65e04334aae79b3041979abbf25f8))
* **handover:** compare process start as an instant and require the session project ([6c6bcbe](https://github.com/programinglive/dev-workflow-mcp-server/commit/6c6bcbe441ddeecdc4011bbcb2dbd0244f0abb0d))
* **handover:** fence a failed claim marker and prove the released receipt ([7179e92](https://github.com/programinglive/dev-workflow-mcp-server/commit/7179e92c64b5267c1242b0b626093d970a103268))
* **handover:** prove release across processes and bind the sidecar path ([1dc1844](https://github.com/programinglive/dev-workflow-mcp-server/commit/1dc1844f30a476dad677c95702f0b8248aaf0d77))
* **handover:** support the pinned state layout and close the remaining races ([0dd8bfc](https://github.com/programinglive/dev-workflow-mcp-server/commit/0dd8bfc8c38b756cdc498a9a06a2544321707621))
* **handover:** verify owner exit and let a successor own the worktree ([00ec998](https://github.com/programinglive/dev-workflow-mcp-server/commit/00ec998f5ef9a245bc0c20ade51eec4471bcb58a))
* **handover:** verify the checkpoint file and fail closed on a damaged counter ([ada9272](https://github.com/programinglive/dev-workflow-mcp-server/commit/ada9272443f02e22855568b4b6b8768138c53a0d))
* **lock:** use one acceptance rule for nested and legacy focus bindings ([#106](https://github.com/programinglive/dev-workflow-mcp-server/issues/106)) ([7e25149](https://github.com/programinglive/dev-workflow-mcp-server/commit/7e2514936313a085d9dfe610337c53e5cc78071e))
* **reaper:** atomic attestation reconciliation and fail-closed focus binding ([#108](https://github.com/programinglive/dev-workflow-mcp-server/issues/108)) ([862514b](https://github.com/programinglive/dev-workflow-mcp-server/commit/862514b33e26d236a79a9e8ab42272c4aea11aa5))
* **restart:** claim the handover with an OS-exclusive link, not read-then-replace ([5914584](https://github.com/programinglive/dev-workflow-mcp-server/commit/5914584c966838aee96227f1992bbd495f248104))
* **restart:** require a verified exit, mandatory identity, and an explicit handover for claim ([d1e484a](https://github.com/programinglive/dev-workflow-mcp-server/commit/d1e484ad1571babc048489b15a8696257494f639))
* **restart:** store the handshake record beside the session state file ([#120](https://github.com/programinglive/dev-workflow-mcp-server/issues/120)) ([b7c18ad](https://github.com/programinglive/dev-workflow-mcp-server/commit/b7c18ada3c08377c57cda9ac2f63d5df6cc9e763)), closes [#842](https://github.com/programinglive/dev-workflow-mcp-server/issues/842)
* **resume:** find left-behind sessions in the per-project users layout ([c69b219](https://github.com/programinglive/dev-workflow-mcp-server/commit/c69b2190a4a30b12369e9f6a5b63ea62fcfacc85))
* **resume:** make adoption commit without the successor's mutex ([05f3c1f](https://github.com/programinglive/dev-workflow-mcp-server/commit/05f3c1f581b23915ee74065e0e603c77bfbce933))
* **security:** stop treating a session identifier as a credential ([#107](https://github.com/programinglive/dev-workflow-mcp-server/issues/107)) ([a231adf](https://github.com/programinglive/dev-workflow-mcp-server/commit/a231adf23d891dcfb15209d902c7500a6b199a52))
* **web:** generate the version banner in English ([ca6a475](https://github.com/programinglive/dev-workflow-mcp-server/commit/ca6a475d78081800193d9037e75cb05e5eabe93c))


### 🧹 Chores

* **deps)(deps:** bump the minor-and-patch group with 5 updates ([#112](https://github.com/programinglive/dev-workflow-mcp-server/issues/112)) ([1e816f8](https://github.com/programinglive/dev-workflow-mcp-server/commit/1e816f8bf128b825ec0ff97468a7a964ca496f2d))
* **deps)(deps:** bump vite from 7.3.7 to 8.3.8 ([#113](https://github.com/programinglive/dev-workflow-mcp-server/issues/113)) ([aab6f10](https://github.com/programinglive/dev-workflow-mcp-server/commit/aab6f105674561a1961dd0786ae9480b08892eae))
* **fleet:** bump pinned toolchain to latest verified versions ([#125](https://github.com/programinglive/dev-workflow-mcp-server/issues/125)) ([aa384d2](https://github.com/programinglive/dev-workflow-mcp-server/commit/aa384d253e0527a198eda38ff176565bf160c429))
* **release:** 1.32.1 ([#116](https://github.com/programinglive/dev-workflow-mcp-server/issues/116)) ([623880a](https://github.com/programinglive/dev-workflow-mcp-server/commit/623880a4d1613188ab718f31b6b5d762300635a1))
* **release:** 1.32.2 ([4724466](https://github.com/programinglive/dev-workflow-mcp-server/commit/4724466f1ee0a42ef8e65a93c0c7e82f63ea11cf))
* **web-deps)(deps:** bump the minor-and-patch group ([#114](https://github.com/programinglive/dev-workflow-mcp-server/issues/114)) ([c5bb643](https://github.com/programinglive/dev-workflow-mcp-server/commit/c5bb64370a222ac81ffad86929a3b69a6a4347ba))


### ✨ Features

* **cli:** add devwf checkpoint for the restart controller ([#118](https://github.com/programinglive/dev-workflow-mcp-server/issues/118)) ([00d6a30](https://github.com/programinglive/dev-workflow-mcp-server/commit/00d6a305b3be5a2791fff4044c68ed7dd9c97b7d))
* **governance:** block unnormalized nullable date coalesce in check_ready_to_commit ([5efcaf6](https://github.com/programinglive/dev-workflow-mcp-server/commit/5efcaf6b8ad67dc48dfbe5b508f4e12b6c909d74))
* **governance:** enforce CLI-First and Documentation-as-Code policies ([#123](https://github.com/programinglive/dev-workflow-mcp-server/issues/123)) ([2391b61](https://github.com/programinglive/dev-workflow-mcp-server/commit/2391b61030bf4bc766c717c96a014b29e64954b9)), closes [#95](https://github.com/programinglive/dev-workflow-mcp-server/issues/95) [#869](https://github.com/programinglive/dev-workflow-mcp-server/issues/869) [#95](https://github.com/programinglive/dev-workflow-mcp-server/issues/95) [#869](https://github.com/programinglive/dev-workflow-mcp-server/issues/869) [#95](https://github.com/programinglive/dev-workflow-mcp-server/issues/95) [#869](https://github.com/programinglive/dev-workflow-mcp-server/issues/869)
* **managed:** fail-closed maintenance admission at the launcher level ([#109](https://github.com/programinglive/dev-workflow-mcp-server/issues/109)) ([c479557](https://github.com/programinglive/dev-workflow-mcp-server/commit/c479557c0b0d5f9a6277cfdcfe26717fdc74ed50))
* **monitor:** centralized fleet restart orchestration ([#111](https://github.com/programinglive/dev-workflow-mcp-server/issues/111)) ([e3aaee2](https://github.com/programinglive/dev-workflow-mcp-server/commit/e3aaee23c731c91e72ff4ddfcf367b8981e33663))
* **monitor:** wire the restart command channel ([#115](https://github.com/programinglive/dev-workflow-mcp-server/issues/115)) ([834f53f](https://github.com/programinglive/dev-workflow-mcp-server/commit/834f53fa6d6e27b9c69d293d70b242dcee6eba37))
* **process-lock:** explicit opt-in for unverified kernel mutex on darwin ([b5f729e](https://github.com/programinglive/dev-workflow-mcp-server/commit/b5f729e6c2bfced0c7f105dc58181c60bbe24ec8))
* **restart:** controller-side exit verification and a usable handover key ([3cca23b](https://github.com/programinglive/dev-workflow-mcp-server/commit/3cca23b9c2c717f1ccf89863f854c79ddbd35d2d))
* **restart:** cooperative owner-side handshake ([#119](https://github.com/programinglive/dev-workflow-mcp-server/issues/119)) ([c05df4e](https://github.com/programinglive/dev-workflow-mcp-server/commit/c05df4e1b233f2cdc165e521ce16f8adace4380e))
* **restart:** same-machine successor claim over a durable handover ([dd0813f](https://github.com/programinglive/dev-workflow-mcp-server/commit/dd0813f7def84b0811642959337a0e6c1b866ed9))
* **restart:** same-machine successor claim over a durable handover ([#121](https://github.com/programinglive/dev-workflow-mcp-server/issues/121)) ([7345d7c](https://github.com/programinglive/dev-workflow-mcp-server/commit/7345d7c1fa3c6c2d59cc6392279c233c728a054a))
* **session:** accept Codex and Antigravity session identity from their real metadata keys ([#110](https://github.com/programinglive/dev-workflow-mcp-server/issues/110)) ([73afee9](https://github.com/programinglive/dev-workflow-mcp-server/commit/73afee94ae9fdfd76823b9c0103d8ee1920302e7))

## [1.31.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.30.0...v1.31.0) (2026-11-12)


### 📝 Documentation

* **architecture:** complete Milestone 0 audit and Zettly integration contract v1 ([dbb3cfc](https://github.com/programinglive/dev-workflow-mcp-server/commit/dbb3cfc3fcf054653401cf3878e0476c742dc00a))
* **opensource:** complete security discovery, extraction strategy, and release checklist ([3c0d1d9](https://github.com/programinglive/dev-workflow-mcp-server/commit/3c0d1d9561a2e9ef28ae2b8a389b4e5cd10e69d4))
* update README with unified 3-plane architecture, Zettly separation, and mobile cockpit ([55949bc](https://github.com/programinglive/dev-workflow-mcp-server/commit/55949bc1af0b729cd8866afd8c9299dbb7eec6fa))


### ✨ Features

* **fleet:** implement Addendum [#5](https://github.com/programinglive/dev-workflow-mcp-server/issues/5) automated fleet update manager and tool sync ([9974148](https://github.com/programinglive/dev-workflow-mcp-server/commit/9974148f13f8662214fa00169ad7ed32a4154e41))
* **fleet:** implement Addendum [#6](https://github.com/programinglive/dev-workflow-mcp-server/issues/6)-[#8](https://github.com/programinglive/dev-workflow-mcp-server/issues/8) universal providers, resume, and upgrade CLI ([b836c77](https://github.com/programinglive/dev-workflow-mcp-server/commit/b836c77fad74407190c120d7687b5cc8a26615b7))
* **mobile:** add IdentityProvider, gateway policy, and Xiaomi Pad 6 M4 UX ([f268cdd](https://github.com/programinglive/dev-workflow-mcp-server/commit/f268cdd9f5aab08ee1cb8ac9e8fbc9a28112779b))
* **mobile:** complete M5-M7 HITL governance, evidence inspector, and Option B+ gate ([9f9e43f](https://github.com/programinglive/dev-workflow-mcp-server/commit/9f9e43f9791616c90b9c1f9bf8bd0e6195eb1b09))
* **mobile:** document M0 architecture audit, gap analysis, and Xiaomi Pad 6 specs ([6dab7fe](https://github.com/programinglive/dev-workflow-mcp-server/commit/6dab7fe45862e7c111f63f7a4e08dfde6657225e))
* **mobile:** implement M1 runtime server configuration and profile switcher ([224d47c](https://github.com/programinglive/dev-workflow-mcp-server/commit/224d47cf2fd68b909cbdc6fd4004a0abf31fa63c))
* **mobile:** upgrade commiter to ^1.5.1 and apply DW Android Companion icon and splash ([dd3aa1e](https://github.com/programinglive/dev-workflow-mcp-server/commit/dd3aa1ec297c4ed42cb675e9369e2c82f1ae902e))
* **release:** complete Option B+ phase 3 readiness, detail fix, and web DW badge ([b56a22b](https://github.com/programinglive/dev-workflow-mcp-server/commit/b56a22bf5f9a7a2934e38b528bbdad78fbb431be))


### ✅ Tests

* **fleet:** add v1.31.0 real session resume verification and release report ([58b62e7](https://github.com/programinglive/dev-workflow-mcp-server/commit/58b62e79da6ee05f848bab1b10c04506b5d927ce))
* update cli/args.js, cli/commands.js, docs/mobile-app.md +11 more ([392df2b](https://github.com/programinglive/dev-workflow-mcp-server/commit/392df2b3c202feb07a34e68b4ba12868059cddb2))
* update docs/mobile-app.md, mobile-app/App.js, mobile-app/connection-manager.js +6 more ([6e2beff](https://github.com/programinglive/dev-workflow-mcp-server/commit/6e2beff118df52ba5ef34dc62f90c3e6404f5be9))


### 🐛 Bug Fixes

* **mobile:** resolve App.js JSX syntax and record Option B+ Canary verification ([0649de6](https://github.com/programinglive/dev-workflow-mcp-server/commit/0649de6a6a52f51d312e816beb9befccdbb77ced))
* **monitor:** replace PAGE version interpolation with runtime token replacement ([7972b53](https://github.com/programinglive/dev-workflow-mcp-server/commit/7972b53c767eef9a91eb7577f0206144cb305b8e))

## [1.30.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.10...v1.30.0) (2026-11-12)


### ✨ Features

* **rules:** enforce CLI-first architecture and document core MCP mechanics ([cdaa505](https://github.com/programinglive/dev-workflow-mcp-server/commit/cdaa5056c3e24fee6018bf5709e061ff9db09ac2))

### [1.29.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.9...v1.29.10) (2026-11-12)


### 📝 Documentation

* **managed:** record the pinned Playwright MCP version ([eaf9552](https://github.com/programinglive/dev-workflow-mcp-server/commit/eaf9552f276914e98ec5f7c0fcb2120691f5e672))


### ✨ Features

* **perf:** token diet and immediate zettly draw integration in start_task ([738e469](https://github.com/programinglive/dev-workflow-mcp-server/commit/738e469d3940b7844f615cc785c4fdd851268f49))

### [1.29.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.8...v1.29.9) (2026-11-12)


### ✨ Features

* **focus:** support multiple active Zettly focuses across MCP tools and guidance ([9a0dbc3](https://github.com/programinglive/dev-workflow-mcp-server/commit/9a0dbc35cf0c733b70e2e1b76ce9bb76fc9bee71))
* **managed:** update focus exception rule for multiple concurrent active focuses ([33a81a3](https://github.com/programinglive/dev-workflow-mcp-server/commit/33a81a3aae64910dce1b6a2fca650849aa142370))

### [1.29.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.7...v1.29.8) (2026-11-12)


### 🐛 Bug Fixes

* **managed:** request the local restart without a deprecated shell ([a4226c2](https://github.com/programinglive/dev-workflow-mcp-server/commit/a4226c2f52d947844046dc1d841d0f568243e672))

### [1.29.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.6...v1.29.7) (2026-11-12)


### 🐛 Bug Fixes

* **managed:** make the fleet reload finish without a false timeout ([dd07def](https://github.com/programinglive/dev-workflow-mcp-server/commit/dd07def310e15aa1eb9e17c5e4a121db26d22551))

### [1.29.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.5...v1.29.6) (2026-11-12)


### 📝 Documentation

* **managed:** record the reload procedure and fix the silent remote heal ([2150134](https://github.com/programinglive/dev-workflow-mcp-server/commit/2150134c98a56060e5518061d8f7a9088be59b1d))

### [1.29.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.4...v1.29.5) (2026-11-12)


### 🧹 Chores

* **ci:** migrate runner from mmch to bw-tools and modernize workflows ([d63454c](https://github.com/programinglive/dev-workflow-mcp-server/commit/d63454c42643380f41f1cfde5ae4d776e5ccef5f))


### ✨ Features

* **focus:** allow several focuses to be active at once ([b4c0dbf](https://github.com/programinglive/dev-workflow-mcp-server/commit/b4c0dbf7fbd899e9397a325da86330a3ba0306b7))
* **focus:** attach the active focus to created artifacts ([41e3cf2](https://github.com/programinglive/dev-workflow-mcp-server/commit/41e3cf2d163704000af3555f9b6a0bb705227027))
* **focus:** write focus_id instead of a description marker ([56ced82](https://github.com/programinglive/dev-workflow-mcp-server/commit/56ced82a4fc2cfa3ee3f4619cb5ce374d191768c))
* **managed:** add fleet status and make restart instructions explicit ([418aeef](https://github.com/programinglive/dev-workflow-mcp-server/commit/418aeefdc4781918642875e868dd993e431ae8b2))
* **managed:** close Codex and Antigravity instead of skipping them ([65a7226](https://github.com/programinglive/dev-workflow-mcp-server/commit/65a722663adb33f0fd5ceebbbfeec99d6da658cf))
* **managed:** reload OpenCode in place and verify the whole fleet ([570e8b5](https://github.com/programinglive/dev-workflow-mcp-server/commit/570e8b5b992a04782b616179ce1733631e70f19e))
* **mobile:** render the Zettly Draw flow on the Android monitor ([5a52f54](https://github.com/programinglive/dev-workflow-mcp-server/commit/5a52f54078b73eef9c2477831dc2d0cb1ac9e65b))
* **monitor:** add clickable runner job link to session cards ([b7bdba1](https://github.com/programinglive/dev-workflow-mcp-server/commit/b7bdba1d30fc66eb425d1174cb2e88a638e34329))
* **monitor:** capture every refinement and make the flow diagram reachable ([#83](https://github.com/programinglive/dev-workflow-mcp-server/issues/83)) ([b492568](https://github.com/programinglive/dev-workflow-mcp-server/commit/b492568df9855f13f8df877a51bd8bc84fce3c00))
* **workflow:** add context-aware task refinement tool ([8f4d4bb](https://github.com/programinglive/dev-workflow-mcp-server/commit/8f4d4bbf193eadbd36555446a6df3310f157f8a6))
* **workflow:** require bug investigation context during refinement ([577fd86](https://github.com/programinglive/dev-workflow-mcp-server/commit/577fd86504f43f3b6003a251b407faf4a46a96fa))


### ♻️ Refactors

* **mcp:** remove retired Factory MCP from ecosystem index and device bootstrap ([e8eaee7](https://github.com/programinglive/dev-workflow-mcp-server/commit/e8eaee7689907d62ae94ebc3ab02ec4fce4f46e9))
* **mcp:** retire Factory from the MCP surface ([#89](https://github.com/programinglive/dev-workflow-mcp-server/issues/89)) ([63ca009](https://github.com/programinglive/dev-workflow-mcp-server/commit/63ca0096634f7830d362bc1f89bdd34301bd11cb))


### 📝 Documentation

* handover for the sentry cleanup session ([539c0bb](https://github.com/programinglive/dev-workflow-mcp-server/commit/539c0bb2e45d3081eee64c03cd354bf2304e409e))
* **rules:** document universal bw-tools runner and sync rules across all devices ([46aa8dd](https://github.com/programinglive/dev-workflow-mcp-server/commit/46aa8dd33c748709dc40356dd9ade5561a01ede0))
* **rules:** stop telling sessions the MMCH runner is still online ([#90](https://github.com/programinglive/dev-workflow-mcp-server/issues/90)) ([2b764bc](https://github.com/programinglive/dev-workflow-mcp-server/commit/2b764bc86bbd8e0e809fdb3b60b34c669fc0dacb))
* **sentry:** add the phase 2 plan with ownership map ([fe9c72e](https://github.com/programinglive/dev-workflow-mcp-server/commit/fe9c72eb5dcc1bf59d763fd6399c81636531d966))
* **sentry:** add the zero-issue execution plan ([4ca7696](https://github.com/programinglive/dev-workflow-mcp-server/commit/4ca76965cef27f4c27f13ac1549af087b42cd69f))
* **sentry:** harden the zero-issue plan with the traps found in practice ([735799a](https://github.com/programinglive/dev-workflow-mcp-server/commit/735799ae73eef6a55739341b5490b086c3a87855))
* **sentry:** note the ERP backup is off-host ([558a53e](https://github.com/programinglive/dev-workflow-mcp-server/commit/558a53eae7bded789a6b449ab7a38de93e4ea30e))
* **sentry:** rebuild the status and plan after v2.41.43 ([460c50c](https://github.com/programinglive/dev-workflow-mcp-server/commit/460c50cd293d18f95f76d94f730ff2bb0ebab341))
* **sentry:** record the ERP pre-reconcile backup and its off-host gap ([23e1b06](https://github.com/programinglive/dev-workflow-mcp-server/commit/23e1b068bbfe25b992a040811867b1abd23cccd7))
* **workflow:** correct the CI runner topology and record the parity audit ([#77](https://github.com/programinglive/dev-workflow-mcp-server/issues/77)) ([b8badea](https://github.com/programinglive/dev-workflow-mcp-server/commit/b8badea777a67a1200da6975c477efdb5a797a0f))


### 🐛 Bug Fixes

* **managed:** reconnect failed MCP servers after a fleet reload ([#92](https://github.com/programinglive/dev-workflow-mcp-server/issues/92)) ([433999b](https://github.com/programinglive/dev-workflow-mcp-server/commit/433999b2ef6a5f8fa212cf04cc1c18c3a7b8a145))
* **mobile:** cache-bust the flow image per app launch ([#86](https://github.com/programinglive/dev-workflow-mcp-server/issues/86)) ([6e19222](https://github.com/programinglive/dev-workflow-mcp-server/commit/6e19222225f284cfa04d0de5a90b90243f581504))
* **mobile:** claim a build host only when the executor reported one ([f5aff5c](https://github.com/programinglive/dev-workflow-mcp-server/commit/f5aff5cb8d61a7ea210ba5a6259cdc4a0a01f17f))
* **mobile:** show the reported build on the Android monitor card ([43543c1](https://github.com/programinglive/dev-workflow-mcp-server/commit/43543c183011c88d302c4c718537fb02c0913542))
* **monitor:** attribute builds to the real build host, not the session machine ([ad1e381](https://github.com/programinglive/dev-workflow-mcp-server/commit/ad1e381845d55c5425c355ef742b452c86cb4e1b))
* **monitor:** log the drawing query string so cache-busting is visible ([#88](https://github.com/programinglive/dev-workflow-mcp-server/issues/88)) ([0ce8d62](https://github.com/programinglive/dev-workflow-mcp-server/commit/0ce8d62f966eaa63f3e73e20073922b3502d534f))
* **monitor:** serve the flow as PNG for the tablet ([#84](https://github.com/programinglive/dev-workflow-mcp-server/issues/84)) ([357ada6](https://github.com/programinglive/dev-workflow-mcp-server/commit/357ada676ab04644d69a8ba9d8e2eb0a0174b662))
* **monitor:** serve the flow as PNG for the tablet ([#85](https://github.com/programinglive/dev-workflow-mcp-server/issues/85)) ([9abf242](https://github.com/programinglive/dev-workflow-mcp-server/commit/9abf242bc6474f50b3f8e4f7eb4a12953dd2a200))
* **process-lock:** verify the holder is a workflow process before treating a lock as live ([3c19136](https://github.com/programinglive/dev-workflow-mcp-server/commit/3c191366f2727c9b5016ecba8d3583cc6becc910))
* **release:** call git without a shell so the caret in ^{commit} survives ([ad87bfa](https://github.com/programinglive/dev-workflow-mcp-server/commit/ad87bfa731faf1f12dba55dd22885b3ff9b05ec7))
* **release:** run the deployment tag checks inside the pinned repo ([91ebfb4](https://github.com/programinglive/dev-workflow-mcp-server/commit/91ebfb41f4aa5d50e53c835e64178b2aa0c61e43))
* **rules:** restore the database backup rule in the source of truth ([#82](https://github.com/programinglive/dev-workflow-mcp-server/issues/82)) ([c3ac20a](https://github.com/programinglive/dev-workflow-mcp-server/commit/c3ac20a3cfdbcb6add941688ab3d8b7b62b570bd))
* **workflow:** refuse an empty start_task description instead of creating a blank task ([8fc22e1](https://github.com/programinglive/dev-workflow-mcp-server/commit/8fc22e19504d0f06c458944ec49d871b931c9e53))
* **workflow:** remind the agent on every reply while the Zettly drawing is missing ([cd26299](https://github.com/programinglive/dev-workflow-mcp-server/commit/cd26299df79bc3f85373706b209eb1f35578baf0))

### [1.29.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.3...v1.29.4) (2026-11-10)


### 📝 Documentation

* **monitor:** record the measured identity cleanup and the four infrastructure Todos ([#73](https://github.com/programinglive/dev-workflow-mcp-server/issues/73)) ([c2a6d66](https://github.com/programinglive/dev-workflow-mcp-server/commit/c2a6d66ab262160265245225940d104555d88ebf))


### ✨ Features

* **managed:** add one command to restart the MCP on every device ([0feb7d7](https://github.com/programinglive/dev-workflow-mcp-server/commit/0feb7d789f42632c515fa957d086f3d5c7ae08d6))
* **workflow:** add a release lock so two sessions cannot release at once ([4f79aed](https://github.com/programinglive/dev-workflow-mcp-server/commit/4f79aedbd271a886c6b66dbdbf62bfc86c9050b9))
* **workflow:** gate task closure on a recorded CI/CD deployment ([9eb89a5](https://github.com/programinglive/dev-workflow-mcp-server/commit/9eb89a50c174917ca33b97ed05980fc1a757edf4))


### 🐛 Bug Fixes

* **mcp:** stop logging healthy startup as an error and make exports unique ([8669bd7](https://github.com/programinglive/dev-workflow-mcp-server/commit/8669bd71d643b6b8fcf6adaafee1ff890a7c7579))
* **mobile:** give the monitor fetch a deadline so the tablet cannot hang ([26949df](https://github.com/programinglive/dev-workflow-mcp-server/commit/26949df14b286b58042d75f5522d31948d922c17))

### [1.29.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.2...v1.29.3) (2026-11-10)


### 🐛 Bug Fixes

* **factory:** read the work session from /api/work because the board payload carries only a badge ([#72](https://github.com/programinglive/dev-workflow-mcp-server/issues/72)) ([bc03ae0](https://github.com/programinglive/dev-workflow-mcp-server/commit/bc03ae0be429330479535d30fa145baad8ff854b))

### [1.29.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.1...v1.29.2) (2026-11-10)


### 🐛 Bug Fixes

* **cleanup:** compare worktree paths case-insensitively on Windows ([806fb27](https://github.com/programinglive/dev-workflow-mcp-server/commit/806fb27befc04b280ae1a9fc42ead40a3d0d0f02))
* **deps:** record the devwf bin in the lockfile ([20a0b36](https://github.com/programinglive/dev-workflow-mcp-server/commit/20a0b36ad3d1ceecdc0d38f2106541313445882c))
* **monitor:** require both a task and a project before a session is recorded, shown or recapped ([#71](https://github.com/programinglive/dev-workflow-mcp-server/issues/71)) ([1aeee75](https://github.com/programinglive/dev-workflow-mcp-server/commit/1aeee7585b146ba2138952cc29f20048570badaf))
* **monitor:** treat a project path as no content and show the release version ([58a8cb1](https://github.com/programinglive/dev-workflow-mcp-server/commit/58a8cb1671d25f621310d377e38761e5a1b3640b))
* resolve Windows short paths and close the state database so the suite is green ([a5031d2](https://github.com/programinglive/dev-workflow-mcp-server/commit/a5031d26545a0a5972d0212877fd5429f65b59e5))

### [1.29.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.29.0...v1.29.1) (2026-11-10)


### 🐛 Bug Fixes

* **managed:** make multi-device rollout host-aware and enforce canonical monitor URL ([2f6e66c](https://github.com/programinglive/dev-workflow-mcp-server/commit/2f6e66c738022f303accec0926b181d3e16b331f))
* **release:** push the release on a branch that exists ([6dd081a](https://github.com/programinglive/dev-workflow-mcp-server/commit/6dd081a6b67ce86189b07d98cb68362777660b14))

## [1.29.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.28.0...v1.29.0) (2026-11-10)


### 🧹 Chores

* **monitor:** checkpoint CI deploy setup for handoff ([a8b4999](https://github.com/programinglive/dev-workflow-mcp-server/commit/a8b49998789b123bba2b062277985a4a355c5eb0))


### 🐛 Bug Fixes

* **monitor:** adopt the original bw-tools host lineage ([baccfcf](https://github.com/programinglive/dev-workflow-mcp-server/commit/baccfcf6cb9de54a704a64e969b5fcccde384dc0))
* **monitor:** close the task row instead of orphaning it at coding ([a287ad1](https://github.com/programinglive/dev-workflow-mcp-server/commit/a287ad1e4497ec9e320a14a068612a4f7e73d29e))
* **monitor:** deploy task-metadata.cjs so card fixes reach production ([9aa59fd](https://github.com/programinglive/dev-workflow-mcp-server/commit/9aa59fdfc932e82bcd2aee12e072841398c407e4))
* **monitor:** make the CI deploy path work on the Windows runner ([02c67f5](https://github.com/programinglive/dev-workflow-mcp-server/commit/02c67f52178bf69daece3bbcee6ab3bee9a7e04c))
* **monitor:** merge closure identity fix into main ([450ac8a](https://github.com/programinglive/dev-workflow-mcp-server/commit/450ac8a60b11fc3847a2f9fccb37d3484bb5c954))
* **monitor:** merge the session identity row into its card so the flow shows ([816d288](https://github.com/programinglive/dev-workflow-mcp-server/commit/816d2882580866c941d3a7cd6711cecfca0ce769))
* **monitor:** point clients and managed rules at the bw-tools monitor host ([b012e01](https://github.com/programinglive/dev-workflow-mcp-server/commit/b012e0157c4e152fca04c48ef54d244d5c3cbdb5))
* **monitor:** reset session close control and ignore retired test report ([b5edee0](https://github.com/programinglive/dev-workflow-mcp-server/commit/b5edee0464d2aed41abd810d8cbf55878d810f60))
* **monitor:** show one repository address per session card ([3cc07c7](https://github.com/programinglive/dev-workflow-mcp-server/commit/3cc07c762e17f07031b24ccd4e4139db79caa871))
* **monitor:** stop recording and counting sessions with no task or title ([bb60614](https://github.com/programinglive/dev-workflow-mcp-server/commit/bb60614b3ec1e65f660d1db38bfaadfa4c2a977d))


### ✅ Tests

* **monitor:** pin handed-off as a terminal phase ([e5a2567](https://github.com/programinglive/dev-workflow-mcp-server/commit/e5a25671b5022c8b5db663e7ded9ef8dedf1c973))
* update README.md, bin/cli.js, cli/args.js +13 more ([0237e91](https://github.com/programinglive/dev-workflow-mcp-server/commit/0237e9102f4d9a21035ea3268de79168556520ca))
* **workflow:** compare state paths case-insensitively on Windows ([dd58551](https://github.com/programinglive/dev-workflow-mcp-server/commit/dd58551914c2db236b6cc4d5a90ad1a9c0e8aa54))
* **workflow:** report the resolved state path when the path guard fails ([e7cf7c0](https://github.com/programinglive/dev-workflow-mcp-server/commit/e7cf7c0dd5f6649ed82d011546029206705bc13a))


### 📝 Documentation

* document cross-machine handoff and list all 60 tools ([fe8a32f](https://github.com/programinglive/dev-workflow-mcp-server/commit/fe8a32f130afbefd9667e4f3db40fb2a0db5f1df))
* **managed:** record the three-device restart onto the version-carrying launcher ([09cf623](https://github.com/programinglive/dev-workflow-mcp-server/commit/09cf623f8d17a394ef1540d7c762bfa9f7bbba5a))
* **managed:** record the version protocol deployment and its verification ([e9b824a](https://github.com/programinglive/dev-workflow-mcp-server/commit/e9b824a2963743dda7f9653d1af0881955161a34))
* **monitor:** explain stale coding rows and the CRLF size gap ([ce7a8b0](https://github.com/programinglive/dev-workflow-mcp-server/commit/ce7a8b00e76bfd287715cf3cfdeaff1f42fa079e))
* **plan:** implementation plan for cross-machine task handoff ([5afe56d](https://github.com/programinglive/dev-workflow-mcp-server/commit/5afe56d557e8ea94e40922ea50f16cda14eb1963))
* **spec:** design cross-machine task handoff via Zettly checkpoints ([91da619](https://github.com/programinglive/dev-workflow-mcp-server/commit/91da6192db623b1c2a4bcf6d26a5d3ff5e3ec53a))
* **zettly:** document normalising legacy tags onto the axes ([75f53cb](https://github.com/programinglive/dev-workflow-mcp-server/commit/75f53cb1f1deb2d7165f2db6f76906e9e6124aff))


### ✨ Features

* **checkpoint:** add a machine-readable checkpoint element to the Zettly block ([dd130b5](https://github.com/programinglive/dev-workflow-mcp-server/commit/dd130b555b95c5cf8d41f725d9678b87702cb0ca))
* **checkpoint:** add checkpoint_task with read-back confirmation ([812d7cf](https://github.com/programinglive/dev-workflow-mcp-server/commit/812d7cf0fa65d063cff76168127cf7c2b942ca42))
* **checkpoint:** produce a bounded revert record and refuse unsafe candidates ([530470b](https://github.com/programinglive/dev-workflow-mcp-server/commit/530470b9f9371537eafecae4990fa7a9de225791))
* **checkpoint:** record the owning machine and base commit at start_task ([0a7db03](https://github.com/programinglive/dev-workflow-mcp-server/commit/0a7db0320f589b41bad4be4ec78e74d0025240b1))
* **handoff:** fetch a checkpoint from another machine over SSH ([498bb57](https://github.com/programinglive/dev-workflow-mcp-server/commit/498bb57ba251a17d5764123d40f7d48cd9874a3b))
* **handoff:** record a handoff with a reason and refuse silent continuation ([e9ab387](https://github.com/programinglive/dev-workflow-mcp-server/commit/e9ab3874a30f628ad37cd0c40bf62b44722a4faf))
* **integration:** land cross-machine handoff and devwf CLI on main ([2f18395](https://github.com/programinglive/dev-workflow-mcp-server/commit/2f183953656c8adf735abf3ae3fd53162f183681))
* **managed:** carry the release version through the protocol and into the monitor ([ef1c952](https://github.com/programinglive/dev-workflow-mcp-server/commit/ef1c952f7150d1e23000c65cff7fd3c0572ecb0c))
* **monitor:** show per-test-case progress on build cards ([d3c0d46](https://github.com/programinglive/dev-workflow-mcp-server/commit/d3c0d4660b14f8c93159ea834e00a4cb5ca3d864))
* **monitor:** show release and tool parity per machine ([e209fd8](https://github.com/programinglive/dev-workflow-mcp-server/commit/e209fd89402217b1441397df8ae18726fd092b2e))
* **workflow:** clean up merged branches and idle worktrees on completion ([9b700a8](https://github.com/programinglive/dev-workflow-mcp-server/commit/9b700a864900a40b765612b620326a40ae4cd074))
* **zettly:** tag todos and drawings on the zettelkasten scheme ([31c3daa](https://github.com/programinglive/dev-workflow-mcp-server/commit/31c3daad4d3030b1b2da2b84c24ed71de652591d))

## [1.28.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.27.1...v1.28.0) (2026-11-08)


### 🐛 Bug Fixes

* **managed:** send the rule sync script over stdin so it survives cmd.exe ([734afe9](https://github.com/programinglive/dev-workflow-mcp-server/commit/734afe968fc574917f5f6d0d3e2cda84d5fcf1e7))
* **managed:** send the rule sync script over stdin so it survives cmd.exe ([5b266ff](https://github.com/programinglive/dev-workflow-mcp-server/commit/5b266ff96dee532fa4ebcde8697c69d409a7d4cc))


### 🧹 Chores

* **release:** merge pre-rebase rule-sync lineage ([9ec5c5f](https://github.com/programinglive/dev-workflow-mcp-server/commit/9ec5c5f97573880cd7da579d362377a3d42dcdd6))


### ✅ Tests

* **monitor:** pass the inlined estimator into the page harnesses ([b166cab](https://github.com/programinglive/dev-workflow-mcp-server/commit/b166cabcd414fcdd78e2a458e4115e2f2e6776d2))
* **process-lock:** pin the lock directory with an absolute drive path ([3200f05](https://github.com/programinglive/dev-workflow-mcp-server/commit/3200f05515ec0046168884b5b674389867b9d9e1))


### ✨ Features

* **builds:** aggregate build durations with nearest-rank percentiles ([23a2a5b](https://github.com/programinglive/dev-workflow-mcp-server/commit/23a2a5b9907ffc3300f25bf515179e2f1ac416c2))
* **builds:** estimate minutes and revise on stall, overdue or failure ([28c8cb5](https://github.com/programinglive/dev-workflow-mcp-server/commit/28c8cb5e4f1e08b224515e282fb3cb953c0886cf))
* **builds:** pair build events into runs with stage durations ([0dbb5d7](https://github.com/programinglive/dev-workflow-mcp-server/commit/0dbb5d76cc642bc3ed27dba54633aadd350d5449))
* **builds:** show the cold-start ETA state instead of nothing ([1e00726](https://github.com/programinglive/dev-workflow-mcp-server/commit/1e00726352109eda50fef24531190e60e6c4c400))
* **monitor:** add the Build tab and a live, trouble-aware ETA ([a245617](https://github.com/programinglive/dev-workflow-mcp-server/commit/a245617e2b62b94fd54723e9b91f828a5dbaa572))
* **monitor:** expose /api/builds/report for build durations ([da052b9](https://github.com/programinglive/dev-workflow-mcp-server/commit/da052b90e530abb47d488867481282b307820557))
* **monitor:** show a repository link on the session card and modal ([d36b5f7](https://github.com/programinglive/dev-workflow-mcp-server/commit/d36b5f77b4dd4b1d95c3c59c789efd65f8b58c26))


### 📝 Documentation

* **plan:** make the build estimate react to trouble ([44f5fc8](https://github.com/programinglive/dev-workflow-mcp-server/commit/44f5fc8c7e1c274fcf418c32bb1e428e32267dc5))
* **readme:** document the build report, the estimator and the build tab ([8b8f03d](https://github.com/programinglive/dev-workflow-mcp-server/commit/8b8f03db5d3a7b34ca3413435ea9bb88aba0103e))
* **spec:** design the build duration report and minute estimate ([2abefe4](https://github.com/programinglive/dev-workflow-mcp-server/commit/2abefe415188b8e1de361b2881fa041a8bc833fd))

### [1.27.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.27.0...v1.27.1) (2026-11-08)


### 🐛 Bug Fixes

* **managed:** probe release lineage with git cat-file -e, not rev-parse --verify ([d6e8346](https://github.com/programinglive/dev-workflow-mcp-server/commit/d6e83462d55e4152734a8adf35d8db22b5809c47))

## [1.27.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.26.0...v1.27.0) (2026-11-08)


### 📝 Documentation

* **monitor:** dedupe Zettly Draw preview section and guard against section duplicates ([1742a6a](https://github.com/programinglive/dev-workflow-mcp-server/commit/1742a6a912bb7bfa7459ee3d27ae850abea91906))
* **release:** add 1.26.0 release notes entry ([0a21873](https://github.com/programinglive/dev-workflow-mcp-server/commit/0a21873c996a62d4ff95a059c7d50b5a79811f5d))


### ✨ Features

* **managed:** enforce forward-only rotation of the central release store ([dbb6bfa](https://github.com/programinglive/dev-workflow-mcp-server/commit/dbb6bfa24d312260649b3c251613d7f14ca800bc))

## [1.26.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.25.0...v1.26.0) (2026-11-08)


### 📝 Documentation

* **monitor:** record devwf table ownership in card-chaining runbook ([17170fd](https://github.com/programinglive/dev-workflow-mcp-server/commit/17170fd46edec59d2a0715622203340df00b4c15))
* **release:** add 1.25.0 release notes entry ([8479b5c](https://github.com/programinglive/dev-workflow-mcp-server/commit/8479b5c3db70f4deb03d1fa1f15ded22f2463413))


### ✨ Features

* **start-task:** show which tasks other sessions hold before choosing ([#63](https://github.com/programinglive/dev-workflow-mcp-server/issues/63)) ([f07f2e0](https://github.com/programinglive/dev-workflow-mcp-server/commit/f07f2e03f1a7f497c12939374ada22220cf88abe))


### 🐛 Bug Fixes

* **managed:** name bw-tools instead of the deleted hosts in the rule block ([e491868](https://github.com/programinglive/dev-workflow-mcp-server/commit/e4918689dd8325b27cfc5898a9735fc1b19d26b6))
* **managed:** send the rule block as base64 so backticks survive the shell ([9baf693](https://github.com/programinglive/dev-workflow-mcp-server/commit/9baf6935614bfd7aa70ccbeeb5c05b162ddd721d))


### 🧹 Chores

* merge origin/main into monitor reconciliation branch ([4f37770](https://github.com/programinglive/dev-workflow-mcp-server/commit/4f37770b2663434ca70a71ded9d81554b05ff95a)), closes [#63](https://github.com/programinglive/dev-workflow-mcp-server/issues/63)

## [1.25.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.24.2...v1.25.0) (2026-11-08)


### 🐛 Bug Fixes

* **docs-gate:** allow ready check to pass when documentation is waived ([e79657a](https://github.com/programinglive/dev-workflow-mcp-server/commit/e79657a043240bf5ad09e3cb3cc55195010ba151))
* **managed:** update rollout target to bw-tools and fix release ownership ([b008ce2](https://github.com/programinglive/dev-workflow-mcp-server/commit/b008ce27585e79830c97927a019e88a4fd147b94))


### 📝 Documentation

* **release:** add 1.24.2 release notes entry ([d582c2e](https://github.com/programinglive/dev-workflow-mcp-server/commit/d582c2e62ac7299459514262c1fc2a2f4ca13181))
* **web:** record the recreated Netlify project id and DNS record ([#60](https://github.com/programinglive/dev-workflow-mcp-server/issues/60)) ([5970751](https://github.com/programinglive/dev-workflow-mcp-server/commit/59707515db556ea5a7eee69cacbd6f9d07932791))


### 🧹 Chores

* reconcile origin/main monitor truth fixes into unified card-chain monitor ([0a414bb](https://github.com/programinglive/dev-workflow-mcp-server/commit/0a414bbc38a43f043af4bb802bb0ec6ce47bc790)), closes [#59](https://github.com/programinglive/dev-workflow-mcp-server/issues/59)

### [1.24.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.24.1...v1.24.2) (2026-11-08)


### 📝 Documentation

* **monitor:** record card-chaining rollout status and upsert compatibility lock ([3b105ea](https://github.com/programinglive/dev-workflow-mcp-server/commit/3b105ead051d432f2b69437d4a8e9350ea035e5c))


### ✨ Features

* **monitor:** unify task-metadata and card-chain models into one upsert and dashboard ([6b3a0f8](https://github.com/programinglive/dev-workflow-mcp-server/commit/6b3a0f88a8dd59beafcc10c89483ea5820f0769f))

### [1.24.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.31...v1.24.1) (2026-11-08)


### ♻️ Refactors

* **state:** jadikan berkas json ekspor saja ([bb44b94](https://github.com/programinglive/dev-workflow-mcp-server/commit/bb44b94fbaecc5bb127237b61ed277595e878d04))


### ✅ Tests

* align race stat identity with initial lstat ([bd62d2c](https://github.com/programinglive/dev-workflow-mcp-server/commit/bd62d2c61bd630a9edc90f21cffaceead9388fce))
* isolate oversized handle checks from OS path ops ([21a0208](https://github.com/programinglive/dev-workflow-mcp-server/commit/21a020866cc6c4e76d445b80ac412748b8742c04))
* make search size race deterministic on Windows ([6c933fb](https://github.com/programinglive/dev-workflow-mcp-server/commit/6c933fb1146fe955d11a44da4a69b38644103254))
* **state:** uji konkurensi dengan dua proses sungguhan ([0643f83](https://github.com/programinglive/dev-workflow-mcp-server/commit/0643f834a9c7efb34f7f4c77673862f571f44eaa))
* update README.md, mobile-app/App.js, monitor-server/dashboard.cjs +1 more ([df21d2c](https://github.com/programinglive/dev-workflow-mcp-server/commit/df21d2c404beabcf671b124f6bda113ffbd6d32f))
* update README.md, monitor.js, tests/monitor-active-sessions.test.js +1 more ([47cbb0f](https://github.com/programinglive/dev-workflow-mcp-server/commit/47cbb0fa20e566c0cf4884ca62267e328afc1e89))
* use plain stat data for Windows size race ([f5ae8da](https://github.com/programinglive/dev-workflow-mcp-server/commit/f5ae8da00cff111261aa263a262d38737a01aa0a))


### 🐛 Bug Fixes

* **db:** jangkar lokasi database ke .state proyek, bukan akar drive ([f5f6f6d](https://github.com/programinglive/dev-workflow-mcp-server/commit/f5f6f6d9c598914b8d90645d6481f8e2dc2c9d1e))
* **factory:** complete_task/force_complete_task/drop_task sekarang menutup task Factory otomatis ([70e33aa](https://github.com/programinglive/dev-workflow-mcp-server/commit/70e33aab6fc7c95a4b1ffc35c4fbc92d2f0c1661))
* **factory:** send Cloudflare Access service token headers ([f86ffed](https://github.com/programinglive/dev-workflow-mcp-server/commit/f86ffed66dae8f5be228a5722a10c73e1c44f793))
* **factory:** send Cloudflare Access service token headers to Factory ([6a0c36b](https://github.com/programinglive/dev-workflow-mcp-server/commit/6a0c36b7d9ded9c501745da8c552c5c41e6d6021))
* **factory:** truncate the auto-task title instead of silently skipping the card ([647f43e](https://github.com/programinglive/dev-workflow-mcp-server/commit/647f43e3406771af920c695c5639d9a2a2b34d9f))
* **factory:** truncate the auto-task title to the API limit ([d37788d](https://github.com/programinglive/dev-workflow-mcp-server/commit/d37788db766c414c4c45516a96977420b59e44e8))
* **mcp:** preserve tool schemas and harden managed startup ([0cb7df2](https://github.com/programinglive/dev-workflow-mcp-server/commit/0cb7df2361d77288fc66c5aa77904501e2c3beb3))
* **monitor:** close session api and button, fix closed filter ([c3483eb](https://github.com/programinglive/dev-workflow-mcp-server/commit/c3483ebace0b222b722946c7ffafdf70f1ed45d3))
* **monitor:** embed poll interval in dashboard client ([#52](https://github.com/programinglive/dev-workflow-mcp-server/issues/52)) ([c767ab7](https://github.com/programinglive/dev-workflow-mcp-server/commit/c767ab7b0a8491f1a751caaf2ba515cf95d59e04))
* preserve escaped newlines in monitor page script ([b73d10e](https://github.com/programinglive/dev-workflow-mcp-server/commit/b73d10e455a6a3e3bc014a1f4a4ce64a1fbf5f79))
* **release:** record existing HEAD releases idempotently and fix clean-worktree git checks ([1fd0154](https://github.com/programinglive/dev-workflow-mcp-server/commit/1fd015487562d55cc5791038c4aefd387894b778))
* report connected MCP session heartbeats ([4292fae](https://github.com/programinglive/dev-workflow-mcp-server/commit/4292fae601a176e521e0e48721b05206edea5c89))
* **share:** cap the rate-limit map and leak-test the HTTP path ([98f3695](https://github.com/programinglive/dev-workflow-mcp-server/commit/98f3695f998ee5aaf878aa91bb39738e4fd598cc))
* **share:** key the rate limit per reader, not per proxy ([10fef70](https://github.com/programinglive/dev-workflow-mcp-server/commit/10fef70354ddc69ec587baf0d865ca272b20fd4b))
* **share:** raise rate limit and explain 429 to readers ([dc0bd66](https://github.com/programinglive/dev-workflow-mcp-server/commit/dc0bd669bba15e3ea8d3fe43e1cfed827a8d7781))
* **share:** return 400/409 instead of 500 on bad body and races ([725d489](https://github.com/programinglive/dev-workflow-mcp-server/commit/725d4898ab1cf11ad88cc9546a1d2e0e0bec7366))
* **share:** stop counting HEAD as a view and count orphans in SQL ([b4ecefd](https://github.com/programinglive/dev-workflow-mcp-server/commit/b4ecefdc48ec3cd92405accb24e4387b8a286312))
* **state:** adapter lokal memakai stateFile sesi sebagai jangkar ([fda2890](https://github.com/programinglive/dev-workflow-mcp-server/commit/fda289023ae69ab20e19a1c9b412eb88af6bbc45))
* **state:** bereskan enam temuan sisa penyimpanan sqlite ([4ae8b0b](https://github.com/programinglive/dev-workflow-mcp-server/commit/4ae8b0b8e8529ea2d973c04421a43897c8e581d8))
* **state:** gagal membaca tidak lagi dianggap "kosong" ([870d495](https://github.com/programinglive/dev-workflow-mcp-server/commit/870d495a161a75e93cc29716415d8b3812f33a39))
* **state:** perbaiki temuan review penyimpanan sqlite ([ecfda98](https://github.com/programinglive/dev-workflow-mcp-server/commit/ecfda98224cf94c4645ee9dd8965228f9ae8fda8))
* **state:** riwayat keluar dari state_json dan tes tidak boleh menulis ke state asli ([6712ac5](https://github.com/programinglive/dev-workflow-mcp-server/commit/6712ac5ac547de76027f0b5988e2f32f6625d452))
* **test:** close SQLite adapters before deleting temp dirs ([95d3c7b](https://github.com/programinglive/dev-workflow-mcp-server/commit/95d3c7b736378be7cd3ed5a8eaae121dc27490b7))
* **tests:** resolve 23 POSIX test failures and dist bundle require path ([c12ec39](https://github.com/programinglive/dev-workflow-mcp-server/commit/c12ec39d0db97693756cf9a789e5aa08b92859e2))
* **web:** ignore netlify build artifacts in eslint ([56abe4e](https://github.com/programinglive/dev-workflow-mcp-server/commit/56abe4e8704a76bb218c72982bbb4689baa0e968))
* **workflow:** enforce English guidance and track owner Zettly tasks ([4d70aa5](https://github.com/programinglive/dev-workflow-mcp-server/commit/4d70aa5cd031024be20133288d5fccbb3eadc8c0))


### ✨ Features

* add bounded local project search ([161eaf1](https://github.com/programinglive/dev-workflow-mcp-server/commit/161eaf1179744ab7f4e6b210c39c8c99e8c9c6ad))
* **db:** antrean replika dengan backoff dan klaim baris ([9a67b94](https://github.com/programinglive/dev-workflow-mcp-server/commit/9a67b948156fdf483768b2276ebdb02e361accde))
* **db:** kelas error state dan normalisasi kunci sesi ([fec2db0](https://github.com/programinglive/dev-workflow-mcp-server/commit/fec2db046341f27ce201ecd5c1fdeaadfc0850c2))
* **db:** migrasi JSON lama ke SQLite dan arsip baris state proyek ([803dff3](https://github.com/programinglive/dev-workflow-mcp-server/commit/803dff3c5887a5e2cba43b75465505d24c9870c6))
* **db:** skema v1 dan state berversi per sesi ([b00747b](https://github.com/programinglive/dev-workflow-mcp-server/commit/b00747b17e7a2e35acceaa81029911107f59e554))
* **handlers:** bedakan konflik state dan penyimpanan tidak tersedia ([82cdba9](https://github.com/programinglive/dev-workflow-mcp-server/commit/82cdba92db53b9fcf2fa5ba7ddf02420beb9963e))
* **managed:** point the release service at bw-tools after the VM move ([11f4d7a](https://github.com/programinglive/dev-workflow-mcp-server/commit/11f4d7a5eb91e278b549ecad4518bda03c0fb66f))
* **mcp-index:** add central MCP ecosystem index and context-aware recommender ([a0c53fb](https://github.com/programinglive/dev-workflow-mcp-server/commit/a0c53fb8906f6852d07650662d44a12fc93a02c7))
* **mcp:** distribute approved releases to managed device launchers ([2aa0049](https://github.com/programinglive/dev-workflow-mcp-server/commit/2aa0049c5f9c1622a3538f3532bbd58b2cde7fe3))
* **monitor:** add chain label and build ownership helpers ([7632282](https://github.com/programinglive/dev-workflow-mcp-server/commit/7632282a2101f7adf8a9d672cba0265d4efd34d7))
* **monitor:** add live build status tracking and redesign dashboard UI/UX ([f2a29bf](https://github.com/programinglive/dev-workflow-mcp-server/commit/f2a29bfa9d768ffc83093b6555ac273c6ebbf660))
* **monitor:** antrean menampung laporan dashboard yang gagal terkirim ([917664e](https://github.com/programinglive/dev-workflow-mcp-server/commit/917664eb36559bfb8dde501b95b83fa332cca2be))
* **monitor:** render card chain links and isolate live build boxes ([49ca850](https://github.com/programinglive/dev-workflow-mcp-server/commit/49ca850e279aad0603171f51c6dc4e8c2dafd081))
* **monitor:** send task identity and parent task in the snapshot ([896286e](https://github.com/programinglive/dev-workflow-mcp-server/commit/896286e956b4033fc3b76826040f81166c81cedb))
* **monitor:** store one card per task with parent hand-off ([6e877c8](https://github.com/programinglive/dev-workflow-mcp-server/commit/6e877c89a6f29832078b54177777d2f1d9ab1b04))
* **share:** add live share panel and drop dead tunnel configs ([ca5fae1](https://github.com/programinglive/dev-workflow-mcp-server/commit/ca5fae140614e9f9b8e7b1f32d361c3f86690f3a))
* **share:** add revocable public share link per session ([cbcf0d0](https://github.com/programinglive/dev-workflow-mcp-server/commit/cbcf0d05234d8fb0ca9c38684666bfd1fbbde4ce))
* **share:** revoke orphaned links instead of expiring them ([773c38a](https://github.com/programinglive/dev-workflow-mcp-server/commit/773c38a4a13aba783ae3825ce999d9e2cca93946))
* **state:** load() dan history membaca dari SQLite ([b16fc4a](https://github.com/programinglive/dev-workflow-mcp-server/commit/b16fc4a96493e78894f9cb56a620c4b20937645f))
* **state:** save() menulis state hidup ke SQLite berversi ([2392d3e](https://github.com/programinglive/dev-workflow-mcp-server/commit/2392d3e219cb98f163818eb867d0e05ccf4f2f52))
* **state:** simpan state workflow di sqlite, postgres jadi replika ([d6925bd](https://github.com/programinglive/dev-workflow-mcp-server/commit/d6925bdd24291fdc9c87ebbabe98fc2a54c2e075))
* **status:** laporkan antrean replika dan pertikaian penulis ([a3b6211](https://github.com/programinglive/dev-workflow-mcp-server/commit/a3b62119c574521e7383a4f83b9ea544e45d3fad))
* tambahkan tool list_active_sessions untuk membaca monitor dashboard ([225bb45](https://github.com/programinglive/dev-workflow-mcp-server/commit/225bb4524bc05e2873b6f529afb77c428ab069b8))
* **workflow:** record the parent task when chaining cards ([ed314d6](https://github.com/programinglive/dev-workflow-mcp-server/commit/ed314d67f924bf180281a1f537961524b1720a5e))


### 📝 Documentation

* catat uji dua proses dan batas yang belum terbukti ([a481ed3](https://github.com/programinglive/dev-workflow-mcp-server/commit/a481ed3e1a3a33093e116928c4c700a309346490))
* jelaskan penyimpanan sqlite di readme dan situs developer ([4e42b41](https://github.com/programinglive/dev-workflow-mcp-server/commit/4e42b416b6f48f7fdc7fdb2c73df9ec4b6e9f08f))
* **managed:** describe bw-tools as the release host ([efc9c27](https://github.com/programinglive/dev-workflow-mcp-server/commit/efc9c274bbf20b4404407e0d25e990b242e32948))
* **mcp:** record verified central release rollout on three devices ([2ab95d5](https://github.com/programinglive/dev-workflow-mcp-server/commit/2ab95d597448a3abd7648884cabc7f1eee047304))
* **monitor:** document Zettelkasten card chaining and isolate database test schemas ([a9b9aa2](https://github.com/programinglive/dev-workflow-mcp-server/commit/a9b9aa23bb9799b435c2f24b37baf98fc988d275))
* **plan:** rencana implementasi state SQLite dalam 10 tugas ([a01be37](https://github.com/programinglive/dev-workflow-mcp-server/commit/a01be37ef04547dccec779a485742080d967cc3c))
* **release:** record 1.24.0 release scope ([d741a6e](https://github.com/programinglive/dev-workflow-mcp-server/commit/d741a6e0944191ceb5130659c947213ead2ff682))
* **release:** record v1.24.0 publication evidence ([e66b78b](https://github.com/programinglive/dev-workflow-mcp-server/commit/e66b78b9ae77f50a7cf9ef8a97f4e7e57f556f2f))
* **share:** correct stale spec and add final verification script ([8b2c7ab](https://github.com/programinglive/dev-workflow-mcp-server/commit/8b2c7abc62cb85e563e549fb2c1ac0e175c2a3f4))
* **share:** note that share origins need a restart ([b0a2c22](https://github.com/programinglive/dev-workflow-mcp-server/commit/b0a2c228d05d7b4bec0115e1b1ec6a1a246df7ae))
* **spec:** putuskan identitas sesi cadangan, antrean, dan penanganan baris state lama ([e58c1bc](https://github.com/programinglive/dev-workflow-mcp-server/commit/e58c1bcb17034afbd5efc2ee09d1f4375d862c13))
* **spec:** state hidup pindah ke SQLite sebagai sumber kebenaran, Postgres jadi replika ([204ac2b](https://github.com/programinglive/dev-workflow-mcp-server/commit/204ac2bc1433a82cf9d49e6b6036bc2a202cd4f0))
* **state:** tandai SHARED-STATE.md tidak berlaku ([7000781](https://github.com/programinglive/dev-workflow-mcp-server/commit/700078170ea67cc17e8ed52dda1c22697af6556b))
* **state:** tata letak penyimpanan state di sqlite ([5b4e98d](https://github.com/programinglive/dev-workflow-mcp-server/commit/5b4e98db6cf15e5c047821c2c3a2d24a6810f0f4))


### 🧹 Chores

* abaikan tmp-probe.db ([4c68d0d](https://github.com/programinglive/dev-workflow-mcp-server/commit/4c68d0dc52c1f8de24a8c741e85b9b9d93b3573c))
* gitignore project-summary.json, tmp-test-state.json, user-id ([8542933](https://github.com/programinglive/dev-workflow-mcp-server/commit/85429330ae1000e7696145d0da04a608aecd4fd8))
* **managed:** ignore Python bytecode produced by the device installer ([1bf6612](https://github.com/programinglive/dev-workflow-mcp-server/commit/1bf66123101624f6a80de2607e264d72c2cd2a87))
* **release:** 1.19.32 🚀 ([f991994](https://github.com/programinglive/dev-workflow-mcp-server/commit/f99199457415154592f5686d890f96de79048feb))
* **release:** 1.20.0 🚀 ([f44f5d7](https://github.com/programinglive/dev-workflow-mcp-server/commit/f44f5d7bea666590f72a61189801310588b0316e))
* **release:** 1.20.1 🚀 ([639d831](https://github.com/programinglive/dev-workflow-mcp-server/commit/639d8318c51edad9bc6da6b4fc4fbbed9c97283b))
* **release:** 1.20.2 🚀 ([e40d079](https://github.com/programinglive/dev-workflow-mcp-server/commit/e40d0795e1a30113ffa783a4a260e533a2f93baa))
* **release:** 1.20.3 🚀 ([a34857c](https://github.com/programinglive/dev-workflow-mcp-server/commit/a34857c367d154a68d876b715b5ced45c4d43402))
* **release:** 1.20.4 🚀 ([195a7f0](https://github.com/programinglive/dev-workflow-mcp-server/commit/195a7f0881a23ffb796325fbcaa2c5045f351155))
* **release:** 1.21.0 🚀 ([05e3672](https://github.com/programinglive/dev-workflow-mcp-server/commit/05e36724cb36e5df4bf00c7d1f1f272021cd92c0))
* **release:** 1.21.1 🚀 ([da4b5e1](https://github.com/programinglive/dev-workflow-mcp-server/commit/da4b5e11d2b51a1d8d2c60ce50cb10db76d67075))
* **release:** 1.22.0 🚀 ([9a0a9b7](https://github.com/programinglive/dev-workflow-mcp-server/commit/9a0a9b7c1cc98476b9e926bcfe6c1e5bba98b5b0))
* **release:** 1.23.0 🚀 ([bc76141](https://github.com/programinglive/dev-workflow-mcp-server/commit/bc761415cba181347fa9ad6aa3c61695a0e45b33))
* **release:** 1.23.1 🚀 ([fc1b4c7](https://github.com/programinglive/dev-workflow-mcp-server/commit/fc1b4c7dffa7d2657f8437e3bb8174b5e6aedb08))
* **release:** 1.23.10 🚀 ([034b83b](https://github.com/programinglive/dev-workflow-mcp-server/commit/034b83b0bce8568126b0159a15c07bc9aa3693e4))
* **release:** 1.23.11 🚀 ([74ad769](https://github.com/programinglive/dev-workflow-mcp-server/commit/74ad7699a52eae6b17046f6f7744aa928d0c28db))
* **release:** 1.23.12 🚀 ([c2d5f19](https://github.com/programinglive/dev-workflow-mcp-server/commit/c2d5f19c40cb1395b376b0fdd0f6c7691bd06d99))
* **release:** 1.23.13 🚀 ([fcefbdf](https://github.com/programinglive/dev-workflow-mcp-server/commit/fcefbdf12d8de45007a648b4b14d87ae69245de8))
* **release:** 1.23.14 🚀 ([2836572](https://github.com/programinglive/dev-workflow-mcp-server/commit/2836572e1b48873b30485aabdec59091521c5432))
* **release:** 1.23.2 🚀 ([33ea400](https://github.com/programinglive/dev-workflow-mcp-server/commit/33ea4001a5460726623afc07f4ce976b006df1d4))
* **release:** 1.23.3 🚀 ([efb948e](https://github.com/programinglive/dev-workflow-mcp-server/commit/efb948e50ee6fce704643ff773e5e461a7610010))
* **release:** 1.23.4 🚀 ([6f96440](https://github.com/programinglive/dev-workflow-mcp-server/commit/6f96440060ce9a1aba8a4298004b8aef2a871f49))
* **release:** 1.23.5 🚀 ([9ebfd2e](https://github.com/programinglive/dev-workflow-mcp-server/commit/9ebfd2e9de36b216e309e8e3c8b084503ee2a703))
* **release:** 1.23.6 🚀 ([3e6d92c](https://github.com/programinglive/dev-workflow-mcp-server/commit/3e6d92c50a8f85a13b023804d35388891b6b0e3a))
* **release:** 1.23.7 🚀 ([9f0c859](https://github.com/programinglive/dev-workflow-mcp-server/commit/9f0c85960a4267ca6a5b55ce26aa5ce24605c38d))
* **release:** 1.23.8 🚀 ([b44f3d7](https://github.com/programinglive/dev-workflow-mcp-server/commit/b44f3d793452ce1bcdc5a3994e39e8f11148db7a))
* **release:** 1.23.9 🚀 ([9c3df87](https://github.com/programinglive/dev-workflow-mcp-server/commit/9c3df8771e2e77132bbe349e819578c297c44848))
* **release:** 1.24.0 🚀 ([422e5e0](https://github.com/programinglive/dev-workflow-mcp-server/commit/422e5e0b76ce0bac2fc76c910382ce17ba25b87c))
* **share:** add scripts to audit and clear probe links ([d9425b2](https://github.com/programinglive/dev-workflow-mcp-server/commit/d9425b2155307c12c9066e1490dbedb68abcbe09))

## [1.24.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.14...v1.24.0) (2026-11-03)


### ✨ Features

* add bounded local project search ([161eaf1](https://github.com/programinglive/dev-workflow-mcp-server/commit/161eaf1179744ab7f4e6b210c39c8c99e8c9c6ad))


### 📝 Documentation

* **release:** record 1.24.0 release scope ([d741a6e](https://github.com/programinglive/dev-workflow-mcp-server/commit/d741a6e0944191ceb5130659c947213ead2ff682))

### [1.23.14](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.13...v1.23.14) (2026-11-03)


### ✅ Tests

* update README.md, mobile-app/App.js, monitor-server/dashboard.cjs +1 more ([df21d2c](https://github.com/programinglive/dev-workflow-mcp-server/commit/df21d2c404beabcf671b124f6bda113ffbd6d32f))

### [1.23.13](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.12...v1.23.13) (2026-11-03)

### [1.23.12](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.11...v1.23.12) (2026-11-03)


### ✅ Tests

* update README.md, monitor.js, tests/monitor-active-sessions.test.js +1 more ([47cbb0f](https://github.com/programinglive/dev-workflow-mcp-server/commit/47cbb0fa20e566c0cf4884ca62267e328afc1e89))

### [1.23.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.10...v1.23.11) (2026-11-03)

### [1.23.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.9...v1.23.10) (2026-11-03)


### ✨ Features

* tambahkan tool list_active_sessions untuk membaca monitor dashboard ([225bb45](https://github.com/programinglive/dev-workflow-mcp-server/commit/225bb4524bc05e2873b6f529afb77c428ab069b8))

### [1.23.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.8...v1.23.9) (2026-11-03)


### 🐛 Bug Fixes

* **share:** raise rate limit and explain 429 to readers ([dc0bd66](https://github.com/programinglive/dev-workflow-mcp-server/commit/dc0bd669bba15e3ea8d3fe43e1cfed827a8d7781))

### [1.23.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.7...v1.23.8) (2026-11-03)


### 📝 Documentation

* **share:** note that share origins need a restart ([b0a2c22](https://github.com/programinglive/dev-workflow-mcp-server/commit/b0a2c228d05d7b4bec0115e1b1ec6a1a246df7ae))

### [1.23.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.6...v1.23.7) (2026-11-03)


### 🧹 Chores

* **share:** add scripts to audit and clear probe links ([d9425b2](https://github.com/programinglive/dev-workflow-mcp-server/commit/d9425b2155307c12c9066e1490dbedb68abcbe09))

### [1.23.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.5...v1.23.6) (2026-11-03)


### 🐛 Bug Fixes

* **share:** cap the rate-limit map and leak-test the HTTP path ([98f3695](https://github.com/programinglive/dev-workflow-mcp-server/commit/98f3695f998ee5aaf878aa91bb39738e4fd598cc))

### [1.23.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.4...v1.23.5) (2026-11-03)


### 🐛 Bug Fixes

* **share:** stop counting HEAD as a view and count orphans in SQL ([b4ecefd](https://github.com/programinglive/dev-workflow-mcp-server/commit/b4ecefdc48ec3cd92405accb24e4387b8a286312))

### [1.23.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.3...v1.23.4) (2026-11-03)


### 🐛 Bug Fixes

* **share:** key the rate limit per reader, not per proxy ([10fef70](https://github.com/programinglive/dev-workflow-mcp-server/commit/10fef70354ddc69ec587baf0d865ca272b20fd4b))

### [1.23.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.2...v1.23.3) (2026-11-03)


### 🐛 Bug Fixes

* **web:** ignore netlify build artifacts in eslint ([56abe4e](https://github.com/programinglive/dev-workflow-mcp-server/commit/56abe4e8704a76bb218c72982bbb4689baa0e968))

### [1.23.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.1...v1.23.2) (2026-11-03)


### 🐛 Bug Fixes

* **test:** close SQLite adapters before deleting temp dirs ([95d3c7b](https://github.com/programinglive/dev-workflow-mcp-server/commit/95d3c7b736378be7cd3ed5a8eaae121dc27490b7))

### [1.23.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.23.0...v1.23.1) (2026-11-03)


### 📝 Documentation

* **share:** correct stale spec and add final verification script ([8b2c7ab](https://github.com/programinglive/dev-workflow-mcp-server/commit/8b2c7abc62cb85e563e549fb2c1ac0e175c2a3f4))

## [1.23.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.22.0...v1.23.0) (2026-11-03)


### ✨ Features

* **share:** revoke orphaned links instead of expiring them ([773c38a](https://github.com/programinglive/dev-workflow-mcp-server/commit/773c38a4a13aba783ae3825ce999d9e2cca93946))

## [1.22.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.21.1...v1.22.0) (2026-11-03)


### ✨ Features

* **share:** add live share panel and drop dead tunnel configs ([ca5fae1](https://github.com/programinglive/dev-workflow-mcp-server/commit/ca5fae140614e9f9b8e7b1f32d361c3f86690f3a))

### [1.21.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.21.0...v1.21.1) (2026-11-02)


### 🐛 Bug Fixes

* **share:** return 400/409 instead of 500 on bad body and races ([725d489](https://github.com/programinglive/dev-workflow-mcp-server/commit/725d4898ab1cf11ad88cc9546a1d2e0e0bec7366))

## [1.21.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.20.4...v1.21.0) (2026-11-02)


### ✨ Features

* **share:** add revocable public share link per session ([cbcf0d0](https://github.com/programinglive/dev-workflow-mcp-server/commit/cbcf0d05234d8fb0ca9c38684666bfd1fbbde4ce))

### [1.20.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.20.3...v1.20.4) (2026-11-02)


### ✅ Tests

* **state:** uji konkurensi dengan dua proses sungguhan ([0643f83](https://github.com/programinglive/dev-workflow-mcp-server/commit/0643f834a9c7efb34f7f4c77673862f571f44eaa))


### 📝 Documentation

* catat uji dua proses dan batas yang belum terbukti ([a481ed3](https://github.com/programinglive/dev-workflow-mcp-server/commit/a481ed3e1a3a33093e116928c4c700a309346490))

### [1.20.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.20.2...v1.20.3) (2026-11-02)


### 🐛 Bug Fixes

* **state:** bereskan enam temuan sisa penyimpanan sqlite ([4ae8b0b](https://github.com/programinglive/dev-workflow-mcp-server/commit/4ae8b0b8e8529ea2d973c04421a43897c8e581d8))


### 📝 Documentation

* jelaskan penyimpanan sqlite di readme dan situs developer ([4e42b41](https://github.com/programinglive/dev-workflow-mcp-server/commit/4e42b416b6f48f7fdc7fdb2c73df9ec4b6e9f08f))

### [1.20.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.20.1...v1.20.2) (2026-11-02)


### ✨ Features

* **monitor:** antrean menampung laporan dashboard yang gagal terkirim ([917664e](https://github.com/programinglive/dev-workflow-mcp-server/commit/917664eb36559bfb8dde501b95b83fa332cca2be))

### [1.20.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.20.0...v1.20.1) (2026-11-02)


### 🐛 Bug Fixes

* **db:** jangkar lokasi database ke .state proyek, bukan akar drive ([f5f6f6d](https://github.com/programinglive/dev-workflow-mcp-server/commit/f5f6f6d9c598914b8d90645d6481f8e2dc2c9d1e))
* **state:** adapter lokal memakai stateFile sesi sebagai jangkar ([fda2890](https://github.com/programinglive/dev-workflow-mcp-server/commit/fda289023ae69ab20e19a1c9b412eb88af6bbc45))

## [1.20.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.32...v1.20.0) (2026-11-02)


### ♻️ Refactors

* **state:** jadikan berkas json ekspor saja ([bb44b94](https://github.com/programinglive/dev-workflow-mcp-server/commit/bb44b94fbaecc5bb127237b61ed277595e878d04))


### 📝 Documentation

* **plan:** rencana implementasi state SQLite dalam 10 tugas ([a01be37](https://github.com/programinglive/dev-workflow-mcp-server/commit/a01be37ef04547dccec779a485742080d967cc3c))
* **spec:** putuskan identitas sesi cadangan, antrean, dan penanganan baris state lama ([e58c1bc](https://github.com/programinglive/dev-workflow-mcp-server/commit/e58c1bcb17034afbd5efc2ee09d1f4375d862c13))
* **spec:** state hidup pindah ke SQLite sebagai sumber kebenaran, Postgres jadi replika ([204ac2b](https://github.com/programinglive/dev-workflow-mcp-server/commit/204ac2bc1433a82cf9d49e6b6036bc2a202cd4f0))
* **state:** tandai SHARED-STATE.md tidak berlaku ([7000781](https://github.com/programinglive/dev-workflow-mcp-server/commit/700078170ea67cc17e8ed52dda1c22697af6556b))
* **state:** tata letak penyimpanan state di sqlite ([5b4e98d](https://github.com/programinglive/dev-workflow-mcp-server/commit/5b4e98db6cf15e5c047821c2c3a2d24a6810f0f4))


### 🐛 Bug Fixes

* **state:** perbaiki temuan review penyimpanan sqlite ([ecfda98](https://github.com/programinglive/dev-workflow-mcp-server/commit/ecfda98224cf94c4645ee9dd8965228f9ae8fda8))
* **state:** riwayat keluar dari state_json dan tes tidak boleh menulis ke state asli ([6712ac5](https://github.com/programinglive/dev-workflow-mcp-server/commit/6712ac5ac547de76027f0b5988e2f32f6625d452))


### 🧹 Chores

* abaikan tmp-probe.db ([4c68d0d](https://github.com/programinglive/dev-workflow-mcp-server/commit/4c68d0dc52c1f8de24a8c741e85b9b9d93b3573c))


### ✨ Features

* **db:** antrean replika dengan backoff dan klaim baris ([9a67b94](https://github.com/programinglive/dev-workflow-mcp-server/commit/9a67b948156fdf483768b2276ebdb02e361accde))
* **db:** kelas error state dan normalisasi kunci sesi ([fec2db0](https://github.com/programinglive/dev-workflow-mcp-server/commit/fec2db046341f27ce201ecd5c1fdeaadfc0850c2))
* **db:** migrasi JSON lama ke SQLite dan arsip baris state proyek ([803dff3](https://github.com/programinglive/dev-workflow-mcp-server/commit/803dff3c5887a5e2cba43b75465505d24c9870c6))
* **db:** skema v1 dan state berversi per sesi ([b00747b](https://github.com/programinglive/dev-workflow-mcp-server/commit/b00747b17e7a2e35acceaa81029911107f59e554))
* **handlers:** bedakan konflik state dan penyimpanan tidak tersedia ([82cdba9](https://github.com/programinglive/dev-workflow-mcp-server/commit/82cdba92db53b9fcf2fa5ba7ddf02420beb9963e))
* **state:** load() dan history membaca dari SQLite ([b16fc4a](https://github.com/programinglive/dev-workflow-mcp-server/commit/b16fc4a96493e78894f9cb56a620c4b20937645f))
* **state:** save() menulis state hidup ke SQLite berversi ([2392d3e](https://github.com/programinglive/dev-workflow-mcp-server/commit/2392d3e219cb98f163818eb867d0e05ccf4f2f52))
* **state:** simpan state workflow di sqlite, postgres jadi replika ([d6925bd](https://github.com/programinglive/dev-workflow-mcp-server/commit/d6925bdd24291fdc9c87ebbabe98fc2a54c2e075))
* **status:** laporkan antrean replika dan pertikaian penulis ([a3b6211](https://github.com/programinglive/dev-workflow-mcp-server/commit/a3b62119c574521e7383a4f83b9ea544e45d3fad))

### [1.19.32](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.31...v1.19.32) (2026-11-02)


### 🐛 Bug Fixes

* **factory:** complete_task/force_complete_task/drop_task sekarang menutup task Factory otomatis ([70e33aa](https://github.com/programinglive/dev-workflow-mcp-server/commit/70e33aab6fc7c95a4b1ffc35c4fbc92d2f0c1661))
* **state:** gagal membaca tidak lagi dianggap "kosong" ([870d495](https://github.com/programinglive/dev-workflow-mcp-server/commit/870d495a161a75e93cc29716415d8b3812f33a39))


### 🧹 Chores

* gitignore project-summary.json, tmp-test-state.json, user-id ([8542933](https://github.com/programinglive/dev-workflow-mcp-server/commit/85429330ae1000e7696145d0da04a608aecd4fd8))

### [1.19.31](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.30...v1.19.31) (2026-11-02)


### 🐛 Bug Fixes

* **monitor:** 'unknown' tidak lagi menimpa label tool yang benar ([5e01eaf](https://github.com/programinglive/dev-workflow-mcp-server/commit/5e01eaf5966762dc99d5cc66bf3e8b6b9393e1a9))

### [1.19.30](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.29...v1.19.30) (2026-11-02)


### 🐛 Bug Fixes

* **monitor:** nama proyek tidak lagi hilang saat task ditutup, dan rekap durasi per proyek ([d5fc53a](https://github.com/programinglive/dev-workflow-mcp-server/commit/d5fc53a5b08409e795d4548e9415747a7454ea31))

### [1.19.29](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.28...v1.19.29) (2026-11-02)


### 🐛 Bug Fixes

* **monitor:** riwayat tidak membuang baris, dan monitor kini memberi tahu ([e558e6a](https://github.com/programinglive/dev-workflow-mcp-server/commit/e558e6a54daa7d646f49385a3488afd0178bf636))

### [1.19.28](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.27...v1.19.28) (2026-11-02)


### ✨ Features

* **app:** bottom navigation dengan tab Riwayat dan filter status ([df3ed26](https://github.com/programinglive/dev-workflow-mcp-server/commit/df3ed262ab6eeacd3d143928bb79bc321e8cf10c))

### [1.19.27](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.26...v1.19.27) (2026-11-02)


### 🐛 Bug Fixes

* **monitor:** label mesin jujur, bukan online/offline ([0640a60](https://github.com/programinglive/dev-workflow-mcp-server/commit/0640a60586d6b5e34a78b2e067f93f272f783f32))

### [1.19.26](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.25...v1.19.26) (2026-11-02)


### ✨ Features

* **factory:** catat task otomatis ke board saat start_task ([ef2cfab](https://github.com/programinglive/dev-workflow-mcp-server/commit/ef2cfab924a25a53592aa10c38d966faf67132a8))

### [1.19.25](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.24...v1.19.25) (2026-11-02)


### 🐛 Bug Fixes

* **factory:** kirim header Origin supaya board menerima task lagi ([50aeb33](https://github.com/programinglive/dev-workflow-mcp-server/commit/50aeb33a451267a62cb11252dbd33f678f27c137))

### [1.19.24](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.23...v1.19.24) (2026-11-02)


### ✨ Features

* **monitor:** riwayat sesi selesai dengan durasi akhir ([5a23c2d](https://github.com/programinglive/dev-workflow-mcp-server/commit/5a23c2d15e313477b08f0c8440a02812f23817e2))

### [1.19.23](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.22...v1.19.23) (2026-11-01)


### ✨ Features

* **monitor:** label alat AI pemanggil (codex/antigravity/opencode) ([28c7f50](https://github.com/programinglive/dev-workflow-mcp-server/commit/28c7f50ad7bf3a649bfa39b82fe712c90c8a88e8))

### [1.19.22](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.21...v1.19.22) (2026-11-01)


### 🐛 Bug Fixes

* **monitor:** gabungkan kartu kembar supaya layar tidak menampilkan sesi dobel ([fda0626](https://github.com/programinglive/dev-workflow-mcp-server/commit/fda0626321e937cf76fe67f65f8d6fc643b72b5a))

### [1.19.21](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.20...v1.19.21) (2026-11-01)


### ✨ Features

* **monitor:** daftar mesin supaya MMCH dan Mac tidak hilang saat menganggur ([470aa6f](https://github.com/programinglive/dev-workflow-mcp-server/commit/470aa6fd07b9435ee400f482e29231ed12e80c68))

### [1.19.20](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.19...v1.19.20) (2026-11-01)


### ✨ Features

* **monitor:** judul sesi OpenCode, grid dua kolom, dan counter timer ([419894b](https://github.com/programinglive/dev-workflow-mcp-server/commit/419894be28298e962d7f4e2ff04d93c3eb789ecc))

### [1.19.19](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.18...v1.19.19) (2026-11-01)


### ✨ Features

* **monitor:** rotasi token satu perintah tanpa memutus mesin ([6e13800](https://github.com/programinglive/dev-workflow-mcp-server/commit/6e138009ce54b72af9865bd05e31e022b369ebf2))

### [1.19.18](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.17...v1.19.18) (2026-11-01)


### 🐛 Bug Fixes

* **clock:** label umur pakai waktu server, bukan jam perangkat ([30285b8](https://github.com/programinglive/dev-workflow-mcp-server/commit/30285b84322b41b015d103c0a5d3436ea305b0d2))

### [1.19.17](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.16...v1.19.17) (2026-11-01)


### 📝 Documentation

* **mobile:** buktikan APK jalan di emulator, bukan hanya terbangun ([9e1ee7a](https://github.com/programinglive/dev-workflow-mcp-server/commit/9e1ee7a87405ec95b3c2f8a2216dad19b0f29852))

### [1.19.16](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.15...v1.19.16) (2026-11-01)


### ✨ Features

* **mobile:** aplikasi Expo untuk tablet, penutup masalah tab Chrome ([ac96ab3](https://github.com/programinglive/dev-workflow-mcp-server/commit/ac96ab3471b6454f5882f4919a38d617c53ed3c5))


### 🧹 Chores

* **mobile:** kunci dependensi aplikasi Expo ([ddd21f6](https://github.com/programinglive/dev-workflow-mcp-server/commit/ddd21f6489954a4225ac55bbf7b179643b3d2bb8))

### [1.19.15](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.14...v1.19.15) (2026-11-01)


### ✨ Features

* **monitor:** penutupan task selalu dikirim, kartu langsung hilang ([1cd5c72](https://github.com/programinglive/dev-workflow-mcp-server/commit/1cd5c72d4618efdcc4bc89fc92232c863602827c))

### [1.19.14](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.13...v1.19.14) (2026-11-01)

### [1.19.13](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.12...v1.19.13) (2026-11-01)


### 🐛 Bug Fixes

* **monitor:** status sesi dari umur laporan, bukan dari phase ([140b167](https://github.com/programinglive/dev-workflow-mcp-server/commit/140b167e562c2d6c18a2cc074e63ef2b34170fcc))

### [1.19.12](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.11...v1.19.12) (2026-11-01)


### ✨ Features

* **monitor:** penanda data masih hidup di dashboard ([4e3b6c5](https://github.com/programinglive/dev-workflow-mcp-server/commit/4e3b6c56de381a4853f36aab0bf4e486520c5b76))

### [1.19.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.10...v1.19.11) (2026-11-01)

### [1.19.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.9...v1.19.10) (2026-11-01)


### 🐛 Bug Fixes

* **monitor:** retensi MATI secara bawaan, tidak menghapus tanpa izin ([f167dac](https://github.com/programinglive/dev-workflow-mcp-server/commit/f167dacc7567917020f92a205783ef9b5a13cb44))

### [1.19.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.8...v1.19.9) (2026-11-01)

### [1.19.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.7...v1.19.8) (2026-11-01)


### ✨ Features

* **monitor:** retensi data dan token untuk endpoint tulis ([81db966](https://github.com/programinglive/dev-workflow-mcp-server/commit/81db9667c33d6ddec342ded5cbea76655c97ecc1))

### [1.19.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.6...v1.19.7) (2026-11-01)

### [1.19.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.5...v1.19.6) (2026-11-01)


### ✨ Features

* **monitor:** idle tanpa task dibuang 5 menit, bukan 30 ([74a248a](https://github.com/programinglive/dev-workflow-mcp-server/commit/74a248aefe3b69abb5c34ca89489eb2e3bee780a))

### [1.19.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.4...v1.19.5) (2026-11-01)

### [1.19.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.3...v1.19.4) (2026-11-01)


### 🐛 Bug Fixes

* **test:** suite tidak lagi menulis sesi palsu ke dashboard ([efb85ba](https://github.com/programinglive/dev-workflow-mcp-server/commit/efb85ba12f4fe9f053b69ae0b97b70879c32b1a9))

### [1.19.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.2...v1.19.3) (2026-11-01)

### [1.19.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.1...v1.19.2) (2026-11-01)


### ✨ Features

* **monitor:** server dashboard masuk repo, sesi idle basi disembunyikan ([03ffbcd](https://github.com/programinglive/dev-workflow-mcp-server/commit/03ffbcd7cdbdba6e9f6aaf9abb1e2707a902ac74))

### [1.19.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.19.0...v1.19.1) (2026-11-01)


### ✨ Features

* **monitor:** peristiwa otomatis untuk aksi penting ([b3ab528](https://github.com/programinglive/dev-workflow-mcp-server/commit/b3ab528ebe645aed83141f9d2069fcee01342f39))


### 🐛 Bug Fixes

* **monitor:** jangan menahan boot lebih dari satu laporan ([7cb59d3](https://github.com/programinglive/dev-workflow-mcp-server/commit/7cb59d36e4d24c1bf24c4e6f1f3ccc721bd55bcc))
* **monitor:** jangan tunggu laporan selama 3 detik pertama boot ([eaf0ba4](https://github.com/programinglive/dev-workflow-mcp-server/commit/eaf0ba4e87a7c2aa1851d6f3bb5897db6d8ff515))
* **test:** ukur startup yang dilaporkan server, bukan waktu dinding ([becf2a4](https://github.com/programinglive/dev-workflow-mcp-server/commit/becf2a44b0cbe63688d74f7327cc5a2e7ec56096))

## [1.19.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.18.1...v1.19.0) (2026-11-01)


### ✨ Features

* **monitor:** laporan sesi live ke dashboard pusat ([114e53f](https://github.com/programinglive/dev-workflow-mcp-server/commit/114e53fcdb62fc8fd4a950fdb06ef069099e8296))

### [1.18.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.18.0...v1.18.1) (2026-11-01)


### 🐛 Bug Fixes

* **workflow:** pesan gerbang jujur, batas waktu git, dan dokumen tata letak state ([30cb08e](https://github.com/programinglive/dev-workflow-mcp-server/commit/30cb08e7f7753c9e23159057b3332e9cd3c1eb69))

## [1.18.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.17.2...v1.18.0) (2026-11-01)


### ✨ Features

* **workflow:** rencana kerja dengan progres, dan sambung ulang state sesi lain ([bf3e92d](https://github.com/programinglive/dev-workflow-mcp-server/commit/bf3e92df5e31d5de4b04f0b9e401f6c7c4e6bc2e))

### [1.17.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.17.1...v1.17.2) (2026-11-01)


### 🐛 Bug Fixes

* **release:** tolak tag yang tidak cocok dengan versi package.json ([07dcce8](https://github.com/programinglive/dev-workflow-mcp-server/commit/07dcce82f7f74b3c9bb001f70c121e3b77e87991))
* **state:** identitas proyek mengikuti projectDir, bukan cwd proses ([fa465b0](https://github.com/programinglive/dev-workflow-mcp-server/commit/fa465b092cd54e3ede8ff7a82015caacd9ffba97))

### [1.17.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.17.0...v1.17.1) (2026-11-01)


### 📝 Documentation

* **spec:** tandai spec isolasi state selesai sebagai 1.17.0 ([5c9bb08](https://github.com/programinglive/dev-workflow-mcp-server/commit/5c9bb0880dd66f4915fabcd4661f15229f55905d))


### 🐛 Bug Fixes

* **review:** tutup jalan pintas gerbang, user-id ganda, dan penjaga yang membeku ([db9e330](https://github.com/programinglive/dev-workflow-mcp-server/commit/db9e3307a7d795ccf870e84897c1e5d503e7ad9d))

## [1.17.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.16.0...v1.17.0) (2026-11-01)


### 🐛 Bug Fixes

* **state:** pisahkan state per sesi di dalam direktori proyek, dan tolak hapus task hidup ([1ba0b26](https://github.com/programinglive/dev-workflow-mcp-server/commit/1ba0b268868c0ddb8cfd4d86c14b8da3ef799287))

## [1.16.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.15.0...v1.16.0) (2026-11-01)


### ✅ Tests

* update tests/handlers-commit.test.js and tools/handler-modules/commit-handlers.js ([762e684](https://github.com/programinglive/dev-workflow-mcp-server/commit/762e68403bd778d94f41f914ac2f7083c65fe3ce))


### 🧹 Chores

* **release:** 1.15.1 🚀 ([f6335ef](https://github.com/programinglive/dev-workflow-mcp-server/commit/f6335ef056b26fcb654bc1d62446e7d54e89dafe))


### 🐛 Bug Fixes

* **lock:** detak jantung jalan di jalur normal, bukan hanya saat lock gagal ([70bef7f](https://github.com/programinglive/dev-workflow-mcp-server/commit/70bef7f7a906413d49d044948edb1a741f4c152e))
* **state:** satu state per proyek saat DEV_WORKFLOW_STATE_FILE dipasang ([5e10599](https://github.com/programinglive/dev-workflow-mcp-server/commit/5e10599955a5d842c7592e46fe1eb935574c4795))
* **state:** toleransi BOM, supaya berkas yang ditulis PowerShell tidak menghapus task ([38be409](https://github.com/programinglive/dev-workflow-mcp-server/commit/38be40906cb82de14ba2022c0cf516f2b8278331))


### ✨ Features

* **workflow:** gerbang dokumentasi, rekomendasi tindak lanjut, dan pemeriksaan update ([0fab371](https://github.com/programinglive/dev-workflow-mcp-server/commit/0fab371bd904f34030aa4cca3d801b2934ba41b8))

### [1.15.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.15.0...v1.15.1) (2026-10-31)


### 🐛 Bug Fixes

* **lock:** detak jantung jalan di jalur normal, bukan hanya saat lock gagal ([c6fa056](https://github.com/programinglive/dev-workflow-mcp-server/commit/c6fa056be1637a5c23cd5c9ca5953de656d9c1e0))

## [1.15.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.14.2...v1.15.0) (2026-10-31)


### ✨ Features

* **lock:** start_task menolak saat sesi lain aktif di proyek yang sama ([e5b0698](https://github.com/programinglive/dev-workflow-mcp-server/commit/e5b069893f3316120225b78da088663ccc725f8d))


### 📝 Documentation

* **lock:** jelaskan penolakan start_task dan cara memakai worktree ([93b8771](https://github.com/programinglive/dev-workflow-mcp-server/commit/93b87710b4f40aec3e0b58be239c609c723fb2e2))

### [1.14.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.14.1...v1.14.2) (2026-10-31)


### 👷 Continuous Integration

* **web:** deploy situs dari GitHub Action dan hasilkan versi saat build ([385e3f2](https://github.com/programinglive/dev-workflow-mcp-server/commit/385e3f2ea8d6eb82a567cd2177df1992a0a5951b))


### ✅ Tests

* **db:** lewati tes adapter saat service tidak ada ([840bde2](https://github.com/programinglive/dev-workflow-mcp-server/commit/840bde2a0af58dcc901e8357833440832c6d8ad8))
* update db/adapters/sqlite.js and tests/db-adapters.test.js ([112ea7f](https://github.com/programinglive/dev-workflow-mcp-server/commit/112ea7fd3ac8d958c9063295b4a4f84c7a86f36d))


### 🐛 Bug Fixes

* **commit:** jangan sapu pekerjaan sesi lain saat commit ([9d66735](https://github.com/programinglive/dev-workflow-mcp-server/commit/9d66735b9c98b3ac4c44fbe2ed17b95da622ec68))
* **release:** jangan blokir rilis karena pekerjaan sesi lain yang ditinggalkan ([616bf3f](https://github.com/programinglive/dev-workflow-mcp-server/commit/616bf3f5880a193068bf0bad03265524cc2406a0))
* **web:** rute yang dihapus menjawab 404 ([5e724b5](https://github.com/programinglive/dev-workflow-mcp-server/commit/5e724b546128940f8d59bd4902ead157d64a2c44))
* **workflow:** run_full_workflow menolak sebelum berjalan tanpa bukti DoD ([562611d](https://github.com/programinglive/dev-workflow-mcp-server/commit/562611d3bf1b104dcff9f21da002c92a002165e1))

### [1.14.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.14.0...v1.14.1) (2026-10-31)


### 🐛 Bug Fixes

* **web:** hapus login dan history yang mati, versi dari manifest root ([a705633](https://github.com/programinglive/dev-workflow-mcp-server/commit/a705633897de0818f81626ee8d7ebfca95399af4))

## [1.14.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.16...v1.14.0) (2026-10-31)


### ✨ Features

* **dod:** add tools to record, prove and waive items ([0fdf0e0](https://github.com/programinglive/dev-workflow-mcp-server/commit/0fdf0e04fe131937c3e7abae5628a5a1645f4606))
* **dod:** gate commit and completion on proven items ([ea93a7a](https://github.com/programinglive/dev-workflow-mcp-server/commit/ea93a7a357419a058302bafc65fdab9beb09a3ac))
* **dod:** persist definition of done in workflow state ([48de33e](https://github.com/programinglive/dev-workflow-mcp-server/commit/48de33ed2a182cc0b15753c551cab5c69e55a005))
* **dod:** pure definition-of-done helpers ([1c510b3](https://github.com/programinglive/dev-workflow-mcp-server/commit/1c510b3a7714d22cd3588445c39947b21347256b))
* **dod:** require a definition of done when starting a task ([6d36c93](https://github.com/programinglive/dev-workflow-mcp-server/commit/6d36c9310e26f9a05132901b8fd6a09a53b49603))
* **dod:** show items in status and import them from the board ([05b4db2](https://github.com/programinglive/dev-workflow-mcp-server/commit/05b4db2e48dd6034ef4e74bc9fe0b58e1e523d1f))


### 📝 Documentation

* **dod:** document the per-item definition of done ([80469d3](https://github.com/programinglive/dev-workflow-mcp-server/commit/80469d3fa5512327908f230bd22aded21138c1c1))
* **spec:** definition of done per item dengan bukti untuk workflow lokal ([06a4edc](https://github.com/programinglive/dev-workflow-mcp-server/commit/06a4edc0aa6d88f9e2b1feb9979de9be6b21262b))
* **spec:** definition of done per item with evidence for the local workflow ([a5a375a](https://github.com/programinglive/dev-workflow-mcp-server/commit/a5a375a5c518945f38b3cbe73bbc987cc490dbba))

### [1.13.16](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.15...v1.13.16) (2026-10-31)


### 🐛 Bug Fixes

* **lock:** one marker per project, always written, and report write failures ([7b3b62f](https://github.com/programinglive/dev-workflow-mcp-server/commit/7b3b62f9d80613c55259e3d6c6e01cf8315910ab))

### [1.13.15](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.14...v1.13.15) (2026-10-31)


### 🐛 Bug Fixes

* **workflow:** claim archives local work, and a clean tree is not "already completed" ([614df9b](https://github.com/programinglive/dev-workflow-mcp-server/commit/614df9b5acfd02b9a58c915881d12095fe412f5a))

### [1.13.14](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.13...v1.13.14) (2026-10-31)


### 🐛 Bug Fixes

* **workflow:** report what actually happened, and stop tests wiping the live task ([8e44b08](https://github.com/programinglive/dev-workflow-mcp-server/commit/8e44b08f4e1a70e8253e68d9e3eba222dd28bbc6))

### [1.13.13](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.12...v1.13.13) (2026-10-31)


### 🐛 Bug Fixes

* **factory:** recover from stale credentials and warn about duplicate MCP processes ([b9bf608](https://github.com/programinglive/dev-workflow-mcp-server/commit/b9bf60884968b77d8cd04aae2a15ff6eeee663f3))

### [1.13.12](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.11...v1.13.12) (2026-10-31)


### 🐛 Bug Fixes

* **state:** gabungkan kemajuan langkah agar dua proses MCP tidak saling menimpa ([2cf0e7c](https://github.com/programinglive/dev-workflow-mcp-server/commit/2cf0e7c36ea60e1cab1e58c769e2f83d37bf496f))

### [1.13.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.10...v1.13.11) (2026-10-31)


### 🐛 Bug Fixes

* **commit:** push branch aktif dan verifikasi HEAD benar-benar terkirim ([4933f6b](https://github.com/programinglive/dev-workflow-mcp-server/commit/4933f6b7ef56e81f84cf459ff79be189bea14938))

### [1.13.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.9...v1.13.10) (2026-10-30)


### 🐛 Bug Fixes

* **exec:** pin repo proyek per sesi, jangan biarkan WORKFLOW_PROJECT_DIR global membajak ([6ba05ff](https://github.com/programinglive/dev-workflow-mcp-server/commit/6ba05ff4fced1b24cbf600dd8a5d27d5f516e81b))

### [1.13.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.8...v1.13.9) (2026-10-30)


### 🐛 Bug Fixes

* **state:** baca user id dari state proyek, bukan cache modul ([79ac773](https://github.com/programinglive/dev-workflow-mcp-server/commit/79ac773471d88066e69d5cb539c10a3a20500983))

### [1.13.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.7...v1.13.8) (2026-10-30)


### 📝 Documentation

* **mcp:** persempit guard ke 6 pola yang hanya menyasar proses node ([bac6721](https://github.com/programinglive/dev-workflow-mcp-server/commit/bac67219db3f0ea1d4a7d4000ec603f282076a9d))

### [1.13.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.6...v1.13.7) (2026-10-30)


### 📝 Documentation

* **security:** analisis allowlist shell berbasis 21k perintah agen ([a1e1bfd](https://github.com/programinglive/dev-workflow-mcp-server/commit/a1e1bfdc1f2df182938a9fbd7bbbc8828d2a12ef))

### [1.13.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.5...v1.13.6) (2026-10-30)


### 📝 Documentation

* **mcp:** perluas guard kill-by-name ke Stop-Process, killall, pkill, wmic ([9e853fe](https://github.com/programinglive/dev-workflow-mcp-server/commit/9e853fe81c39a7e6bf2e1ab4f65b782865105f61))

### [1.13.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.4...v1.13.5) (2026-10-30)


### 📝 Documentation

* **mcp:** catat bahwa MCP mati karena kill node.exe, bukan bug playwright ([49ad25f](https://github.com/programinglive/dev-workflow-mcp-server/commit/49ad25f38b0626a26f6537333d10c54149bb6fb8))

### [1.13.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.3...v1.13.4) (2026-10-30)


### 🐛 Bug Fixes

* **release:** verifikasi versi semver setelah rilis sebelum tag di-push ([da82a4e](https://github.com/programinglive/dev-workflow-mcp-server/commit/da82a4eb09f8d65e3028a04a94f86ee77fca897a))

### [1.13.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.2...v1.13.3) (2026-10-30)


### 🐛 Bug Fixes

* **exec:** izinkan repo paket sebagai direktori kerja bila cwd memang di dalamnya ([68b7944](https://github.com/programinglive/dev-workflow-mcp-server/commit/68b79440806fb47d3fbfb2534085a9ae0c77b4a4))
* **release:** kirim --release-as tepat sekali agar versi tidak menjadi null ([9a52627](https://github.com/programinglive/dev-workflow-mcp-server/commit/9a52627291345017afebee2b5d1ae97a8a356da4))

### [1.13.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.13.1...v1.13.2) (2026-10-30)


### 🐛 Bug Fixes

* **git:** jangan klaim sukses commit saat git tidak bisa dijalankan ([7008538](https://github.com/programinglive/dev-workflow-mcp-server/commit/7008538a3e2349d9834c4e222f4a7d6b3b205390))

### [1.13.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.12.3...v1.13.1) (2026-10-30)


### ✨ Features

* **mcp:** kirim dan tampilkan definisi selesai task ([9fbd03b](https://github.com/programinglive/dev-workflow-mcp-server/commit/9fbd03b85e88d2fb88cd6f81de6c937825957a43))
* **mcp:** tambah tool update_factory_task ([a087aee](https://github.com/programinglive/dev-workflow-mcp-server/commit/a087aee2ef8a444546660f74b2bda3d3de5872e1))
* **security:** enforce credential isolation across workflow boundaries ([fd225a8](https://github.com/programinglive/dev-workflow-mcp-server/commit/fd225a848654f974113810419ed5322fda9d5eae))
* **security:** integrate session-aware workflow and guard shared history ([0fb9a45](https://github.com/programinglive/dev-workflow-mcp-server/commit/0fb9a45022d5c60e79fc5a4b7b1481b852a6fa37))


### 🧹 Chores

* **release:** 1.13.0 🚀 ([d36e23e](https://github.com/programinglive/dev-workflow-mcp-server/commit/d36e23ebf9235cee70487f0d50200e2f448782a7))


### 📝 Documentation

* **release:** catat rilis 1.12.3 ([678f105](https://github.com/programinglive/dev-workflow-mcp-server/commit/678f1051e285273b5ee5aa50c00ec32663e3018a))
* **state:** samakan teks peringatan konflik dengan perilaku sebenarnya ([c9489a7](https://github.com/programinglive/dev-workflow-mcp-server/commit/c9489a7f3e4e9cef2f1f2d87c124b67fd6ffb62e))


### 🐛 Bug Fixes

* **db:** normalisasi taskType dan jangan hentikan sync saat satu entri gagal ([20975cd](https://github.com/programinglive/dev-workflow-mcp-server/commit/20975cddac3cceb9bd7b3292c44780b2075d404f))
* **deps:** benahi penempatan conventional-commits-filter di lockfile ([d401129](https://github.com/programinglive/dev-workflow-mcp-server/commit/d401129f77c53e17024251c44cd0e85c7834fe5c))
* **factory:** izinkan review ulang setelah work.paused ([e81c236](https://github.com/programinglive/dev-workflow-mcp-server/commit/e81c2364822942296a7dde314b5622afc29f96b5))
* **mcp:** cegah review ganda, tampilkan UUID penuh, jangan commit di repo paket ([c94fe30](https://github.com/programinglive/dev-workflow-mcp-server/commit/c94fe30d3b1703c9823f13199d188cf2e0b6b825))
* **mcp:** tampilkan definisi selesai saat melaporkan status ([ad460f2](https://github.com/programinglive/dev-workflow-mcp-server/commit/ad460f26f0121aa0a4fbf8fd8833280193fd90c3))
* **state:** cegah penulis basi menimpa task yang lebih baru ([1000407](https://github.com/programinglive/dev-workflow-mcp-server/commit/1000407a275c4a7801c082880a210243d1fbc3ce))
* **state:** peringatan konflik di depan, sebut aksi tidak berlaku ([4e31f07](https://github.com/programinglive/dev-workflow-mcp-server/commit/4e31f071b6e0a2612c4efee165c4dc8307b0d739))

## [1.13.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.12.3...v1.13.0) (2026-10-29)


### 📝 Documentation

* **release:** catat rilis 1.12.3 ([678f105](https://github.com/programinglive/dev-workflow-mcp-server/commit/678f1051e285273b5ee5aa50c00ec32663e3018a))


### 🐛 Bug Fixes

* **factory:** izinkan review ulang setelah work.paused ([e81c236](https://github.com/programinglive/dev-workflow-mcp-server/commit/e81c2364822942296a7dde314b5622afc29f96b5))
* **mcp:** cegah review ganda, tampilkan UUID penuh, jangan commit di repo paket ([c94fe30](https://github.com/programinglive/dev-workflow-mcp-server/commit/c94fe30d3b1703c9823f13199d188cf2e0b6b825))
* **mcp:** tampilkan definisi selesai saat melaporkan status ([ad460f2](https://github.com/programinglive/dev-workflow-mcp-server/commit/ad460f26f0121aa0a4fbf8fd8833280193fd90c3))


### ✨ Features

* **mcp:** kirim dan tampilkan definisi selesai task ([9fbd03b](https://github.com/programinglive/dev-workflow-mcp-server/commit/9fbd03b85e88d2fb88cd6f81de6c937825957a43))
* **mcp:** tambah tool update_factory_task ([a087aee](https://github.com/programinglive/dev-workflow-mcp-server/commit/a087aee2ef8a444546660f74b2bda3d3de5872e1))
* **security:** enforce credential isolation across workflow boundaries ([fd225a8](https://github.com/programinglive/dev-workflow-mcp-server/commit/fd225a848654f974113810419ed5322fda9d5eae))
* **security:** integrate session-aware workflow and guard shared history ([0fb9a45](https://github.com/programinglive/dev-workflow-mcp-server/commit/0fb9a45022d5c60e79fc5a4b7b1481b852a6fa37))

### [1.12.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.12.2...v1.12.3) (2026-10-28)


### 📝 Documentation

* **release:** catat rilis 1.12.2 ([5c67101](https://github.com/programinglive/dev-workflow-mcp-server/commit/5c6710192a70efbc38af7d7bb31ac8a6baae6dfb))


### 🐛 Bug Fixes

* **factory:** kirim alasan pada move_task agar task bisa ditutup ([88f6b48](https://github.com/programinglive/dev-workflow-mcp-server/commit/88f6b48cc056166e198f248ac43a79351efe33d3))

### [1.12.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.12.1...v1.12.2) (2026-10-28)


### 📝 Documentation

* **release:** catat rilis 1.12.1 ([3beaa23](https://github.com/programinglive/dev-workflow-mcp-server/commit/3beaa23c4a3115f3e57281c5f516fb4b86c22d89))


### 🐛 Bug Fixes

* **state:** ambil identitas sesi dari request metadata, bukan env ([f879938](https://github.com/programinglive/dev-workflow-mcp-server/commit/f8799383421f7ebe2b59f2d3f4daa5fdff0d8e9d))

### [1.12.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.12.0...v1.12.1) (2026-10-28)


### 📝 Documentation

* **release:** catat rilis 1.12.0 ([bb8624b](https://github.com/programinglive/dev-workflow-mcp-server/commit/bb8624b635768df999c5d7986072cb118b324a36))


### ♻️ Refactors

* **state:** tentukan projectRoot dari letak .state, bukan jumlah dirname ([7ba5755](https://github.com/programinglive/dev-workflow-mcp-server/commit/7ba5755d2932e029dd2d6c61ee2e1cf5d2aaf582))

## [1.12.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.11.0...v1.12.0) (2026-10-28)


### 📝 Documentation

* **release:** catat rilis 1.11.0 ([44d6657](https://github.com/programinglive/dev-workflow-mcp-server/commit/44d665717f226ba44f83a76ec8882e2a14aa98e9))


### ✨ Features

* **state:** pisahkan state workflow per sesi, history tetap milik proyek ([f6da2a6](https://github.com/programinglive/dev-workflow-mcp-server/commit/f6da2a65b5e1ffa6c3199fe198a06100edc50816))

## [1.11.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.10.0...v1.11.0) (2026-10-28)


### 📝 Documentation

* **release:** catat rilis 1.10.0 ([a57dba4](https://github.com/programinglive/dev-workflow-mcp-server/commit/a57dba414505e2fc585d5b839cae976208dd2ee1))


### 🐛 Bug Fixes

* **mcp:** laporkan pengambil alihan dan rapikan pesan penolakan ([02b9e33](https://github.com/programinglive/dev-workflow-mcp-server/commit/02b9e33218775a72a4c1834b2cc68213e2facf3f))


### ✨ Features

* **mcp:** heartbeat otomatis dan identitas perangkat bersama CLI ([11e73e0](https://github.com/programinglive/dev-workflow-mcp-server/commit/11e73e03c0f7d8cc2f8446fb6a2bb22fb158bff2))


### 🧹 Chores

* **license:** make Clinic proprietary and refresh README ([7cd2bda](https://github.com/programinglive/dev-workflow-mcp-server/commit/7cd2bdad9ee6792636c5be4c89682e04022a50bf))

## [1.10.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.9.1...v1.10.0) (2026-10-28)


### ✅ Tests

* run MySQL and PostgreSQL adapters against real servers ([#31](https://github.com/programinglive/dev-workflow-mcp-server/issues/31)) ([9b6aaef](https://github.com/programinglive/dev-workflow-mcp-server/commit/9b6aaef65ea95aeb6c34f228cd3d5c1f2566a492))


### 👷 Continuous Integration

* build releases on MMCH, publish on a hosted runner ([#9](https://github.com/programinglive/dev-workflow-mcp-server/issues/9)) ([e975796](https://github.com/programinglive/dev-workflow-mcp-server/commit/e975796e9ffef7d250afb0d478472a1614916ed2)), closes [#7](https://github.com/programinglive/dev-workflow-mcp-server/issues/7)
* publish without provenance while the repo stays private ([#12](https://github.com/programinglive/dev-workflow-mcp-server/issues/12)) ([6dbc16f](https://github.com/programinglive/dev-workflow-mcp-server/commit/6dbc16fa5d5e4b804ae7b838b760cea6d5ddafaf))
* run tests on the self-hosted MMCH runner ([#7](https://github.com/programinglive/dev-workflow-mcp-server/issues/7)) ([ad296f1](https://github.com/programinglive/dev-workflow-mcp-server/commit/ad296f1debfed5de61da5401a14f8a776ed49227))
* verify the built bundle actually starts ([#44](https://github.com/programinglive/dev-workflow-mcp-server/issues/44)) ([dbaa2a8](https://github.com/programinglive/dev-workflow-mcp-server/commit/dbaa2a8c8ff999c7184cbccc0c10290d0ea54bb0))


### 🧹 Chores

* **ci:** add dependabot configuration ([#15](https://github.com/programinglive/dev-workflow-mcp-server/issues/15)) ([80ca440](https://github.com/programinglive/dev-workflow-mcp-server/commit/80ca4406c46a9b684977de9d21702a3ca5d92526))
* **ci:** bump actions/checkout from 4 to 7 ([#16](https://github.com/programinglive/dev-workflow-mcp-server/issues/16)) ([cea2089](https://github.com/programinglive/dev-workflow-mcp-server/commit/cea208973e6b966bfe140d09c42b11f5ab30cf46))
* **ci:** bump actions/download-artifact from 4 to 8 ([#18](https://github.com/programinglive/dev-workflow-mcp-server/issues/18)) ([a957d40](https://github.com/programinglive/dev-workflow-mcp-server/commit/a957d40aa7f8fa72d31e7c24239023df8775cf75))
* **ci:** bump actions/github-script from 7 to 9 ([#17](https://github.com/programinglive/dev-workflow-mcp-server/issues/17)) ([1cdeda5](https://github.com/programinglive/dev-workflow-mcp-server/commit/1cdeda51132bc5b4f32e7345bcebbfdca130975b))
* **ci:** bump actions/setup-node from 4 to 7 ([#19](https://github.com/programinglive/dev-workflow-mcp-server/issues/19)) ([d147a9e](https://github.com/programinglive/dev-workflow-mcp-server/commit/d147a9e142513872b774cfc91a4aff2e72789d85))
* **ci:** bump actions/upload-artifact from 4 to 7 ([#20](https://github.com/programinglive/dev-workflow-mcp-server/issues/20)) ([01f4902](https://github.com/programinglive/dev-workflow-mcp-server/commit/01f49024d0077b125b15de1df1502dfefb0966d9))
* **ci:** keep tailwind on v3 and stop dependabot proposing v4 ([#46](https://github.com/programinglive/dev-workflow-mcp-server/issues/46)) ([71193a7](https://github.com/programinglive/dev-workflow-mcp-server/commit/71193a7631adfdbff6fb6410b794efbff4d8e8e1))
* **deps)(deps:** bump the minor-and-patch group with 5 updates ([#21](https://github.com/programinglive/dev-workflow-mcp-server/issues/21)) ([65be648](https://github.com/programinglive/dev-workflow-mcp-server/commit/65be648dda4d6974065c7579e7577db05eff62ee))
* **deps:** bump commitlint to 21 and align config-conventional ([#32](https://github.com/programinglive/dev-workflow-mcp-server/issues/32)) ([df59f39](https://github.com/programinglive/dev-workflow-mcp-server/commit/df59f39b1ffd84a0f1c5613e5369b2be98090067))
* **deps:** bump dotenv to 18 ([#41](https://github.com/programinglive/dev-workflow-mcp-server/issues/41)) ([b8ee057](https://github.com/programinglive/dev-workflow-mcp-server/commit/b8ee0579037583541dd738eb8798010f38bae532))
* **deps:** bump typescript to 7 ([#33](https://github.com/programinglive/dev-workflow-mcp-server/issues/33)) ([0b292fc](https://github.com/programinglive/dev-workflow-mcp-server/commit/0b292fc7dc0b8a7bbdfd96a5f5892a388fb7713f))
* **deps:** drop root dependencies that only the dashboard uses ([#34](https://github.com/programinglive/dev-workflow-mcp-server/issues/34)) ([cf2a529](https://github.com/programinglive/dev-workflow-mcp-server/commit/cf2a529024e36a72d37bfc7ad34839f0159888ea))
* regenerate package-lock.json to fix ECOMPROMISED error ([83c9ba0](https://github.com/programinglive/dev-workflow-mcp-server/commit/83c9ba06fce6acd01c3ee3bd95c26e3f8b42930f))
* **web-deps)(deps:** bump dotenv from 17.2.3 to 18.0.9 in /web ([#27](https://github.com/programinglive/dev-workflow-mcp-server/issues/27)) ([baa2d5c](https://github.com/programinglive/dev-workflow-mcp-server/commit/baa2d5cbdf1d37a65a117fba1a53d5284a18317b))
* **web-deps)(deps:** bump the minor-and-patch group ([#26](https://github.com/programinglive/dev-workflow-mcp-server/issues/26)) ([9deefc1](https://github.com/programinglive/dev-workflow-mcp-server/commit/9deefc12ab090bd2acf49de0926a11aca9e169e5))
* **web-deps:** bump @types/node to 26 in web ([#42](https://github.com/programinglive/dev-workflow-mcp-server/issues/42)) ([0f4f5e2](https://github.com/programinglive/dev-workflow-mcp-server/commit/0f4f5e2a2aad053431271bb74ddde42d24bbc664))
* **web-deps:** bump eslint to 10 and fix the lint script ([#39](https://github.com/programinglive/dev-workflow-mcp-server/issues/39)) ([6477024](https://github.com/programinglive/dev-workflow-mcp-server/commit/6477024a2dc63f7a02698060dce70a063d4abf7d))
* **web-deps:** bump lucide-react to 1.x and replace the removed Github icon ([#40](https://github.com/programinglive/dev-workflow-mcp-server/issues/40)) ([a4db628](https://github.com/programinglive/dev-workflow-mcp-server/commit/a4db6281514e5481a1754153c41053a663ae24fe))
* **web-deps:** bump typescript to 7 in web and migrate import assertions ([#43](https://github.com/programinglive/dev-workflow-mcp-server/issues/43)) ([3e00a26](https://github.com/programinglive/dev-workflow-mcp-server/commit/3e00a26e3d35c374cac98bb292c23761318fe0e1))
* **web:** update version to 1.9.1 ([6b0eb38](https://github.com/programinglive/dev-workflow-mcp-server/commit/6b0eb383a1db85b6045197f5b062e1252c4ff706))


### 🐛 Bug Fixes

* **build:** keep dotenv external so the bundle can start ([#45](https://github.com/programinglive/dev-workflow-mcp-server/issues/45)) ([d889c8f](https://github.com/programinglive/dev-workflow-mcp-server/commit/d889c8f27d55268387c6d82e0742bdf397445cdc))
* **ci:** do not fail release when the bundle exits after stdin closes ([#10](https://github.com/programinglive/dev-workflow-mcp-server/issues/10)) ([033ea9a](https://github.com/programinglive/dev-workflow-mcp-server/commit/033ea9aa2fa3077a23dca566b432a8dfbeb2301b))
* **ci:** use Node 24 in the publish job so npm@latest can install ([#11](https://github.com/programinglive/dev-workflow-mcp-server/issues/11)) ([283b7d5](https://github.com/programinglive/dev-workflow-mcp-server/commit/283b7d5544648745e6d250cef5aac0e75fa529d4))
* clear remaining devDependency advisories ([#5](https://github.com/programinglive/dev-workflow-mcp-server/issues/5)) ([97deb5f](https://github.com/programinglive/dev-workflow-mcp-server/commit/97deb5f5e4669259d7d8288821e325d4b1881497))
* repair stale test assertions and clear production audit ([#4](https://github.com/programinglive/dev-workflow-mcp-server/issues/4)) ([b018012](https://github.com/programinglive/dev-workflow-mcp-server/commit/b018012106a5b3eade15ccc996eeb0e8620893fe))
* **scripts:** make stack setup work on OpenCode V2 ([#3](https://github.com/programinglive/dev-workflow-mcp-server/issues/3)) ([a2a1618](https://github.com/programinglive/dev-workflow-mcp-server/commit/a2a161824bdb68723de9053ac53b7da767c393ca))
* **state:** stop losing in-progress work when workflow state is shared between sessions ([3cb34f1](https://github.com/programinglive/dev-workflow-mcp-server/commit/3cb34f1a465a8084706a00da006046fce1591e5c))
* **web:** clear dashboard advisories and add CI coverage ([#8](https://github.com/programinglive/dev-workflow-mcp-server/issues/8)) ([790e551](https://github.com/programinglive/dev-workflow-mcp-server/commit/790e5515c708f463ee00ff20406c2147620356bb))


### ✨ Features

* add AGENTS.md enforcement rules and auto-creation during stack setup ([08633a6](https://github.com/programinglive/dev-workflow-mcp-server/commit/08633a66c6f1a30d9047432c135cdcefd91080f7))
* add remote bootstrap scripts for Windows (HELLOWORLD) and macOS (Mac) ([4bb5db5](https://github.com/programinglive/dev-workflow-mcp-server/commit/4bb5db544236cf90c25275aef2b2db5abdd85e8d))
* add Software Factory architecture docs and API endpoints for factory.programinglive.com ([fde59aa](https://github.com/programinglive/dev-workflow-mcp-server/commit/fde59aa04a17dab179437efaf95289f7b71783e5))
* add unified setup script for AI Agent Development Stack (Workflow + Superpowers + RTK) ([6c9a0a8](https://github.com/programinglive/dev-workflow-mcp-server/commit/6c9a0a89d93b007df3030b9cf9b7bbed06acad4c))
* **factory:** izinkan agen menandai task selesai (approve) dari sync_task_status ([38e7343](https://github.com/programinglive/dev-workflow-mcp-server/commit/38e7343be896e08363184ecd56e463ff2cc2d06b))
* **factory:** read and update your Factory task queue from MCP ([#14](https://github.com/programinglive/dev-workflow-mcp-server/issues/14)) ([482ef5a](https://github.com/programinglive/dev-workflow-mcp-server/commit/482ef5ab5738428205e6283cf93eb9dc14cff95e))
* **factory:** tambah create_factory_task dan list_factory_projects ([1c5ed69](https://github.com/programinglive/dev-workflow-mcp-server/commit/1c5ed69b17d01399f4e8f009ec193f8b703857b7))
* **factory:** wire MCP to the real Factory API instead of PocketBase activity_tasks ([fa841c6](https://github.com/programinglive/dev-workflow-mcp-server/commit/fa841c61a99faeb844ec75393cc2ea3676d5651c))
* **mcp:** kirim alasan takeover dan ekspos respons 409 Factory ([caf1c30](https://github.com/programinglive/dev-workflow-mcp-server/commit/caf1c30eba1705437e69aefd17eb4e394f27b436))
* **mcp:** kirim identitas sesi editor, dan izinkan status done ([58929f1](https://github.com/programinglive/dev-workflow-mcp-server/commit/58929f11aab9b1fd0db3456b06696c6f6ab1b386))
* **mcp:** takeover task milik perangkat lain lewat alasan ([d35c777](https://github.com/programinglive/dev-workflow-mcp-server/commit/d35c777ac489151cc27ba3e8a61fa2c7d60bd5a9))
* **web:** add mermaid visual planning to landing page ([519868e](https://github.com/programinglive/dev-workflow-mcp-server/commit/519868e8571df618d3fce5ebc26d9782f3269a5c))


### 📝 Documentation

* **mcp:** dokumentasikan parameter takeoverReason ([6e96422](https://github.com/programinglive/dev-workflow-mcp-server/commit/6e964221bfface1c27c30e03e14e751e38c7571e))
* rewrite README in English and correct stale claims ([#13](https://github.com/programinglive/dev-workflow-mcp-server/issues/13)) ([d88951b](https://github.com/programinglive/dev-workflow-mcp-server/commit/d88951b15f32047ed88115a383632f3829a0f392))
* rewrite README with quickstart guide, add homelab docs, fix Windows path tests ([f6f4910](https://github.com/programinglive/dev-workflow-mcp-server/commit/f6f4910725319af6c001d997525125777305e480))
* **web:** add mermaid feature flow to documentation ([83ab683](https://github.com/programinglive/dev-workflow-mcp-server/commit/83ab6835fdb5c669a9db0a264b5938881231db1e))

### [1.9.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.9.0...v1.9.1) (2026-01-29)


### ✨ Features

* **workflow:** add mermaid diagram and fix high severity tar vulnerability ([32b47fa](https://github.com/programinglive/dev-workflow-mcp-server/commit/32b47fac21693eafe3cfe6dc8b6986c010b76f34))

## [1.9.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.8.1...v1.9.0) (2026-01-29)


### 📝 Documentation

* record release notes for v1.8.1 ([fd213dd](https://github.com/programinglive/dev-workflow-mcp-server/commit/fd213ddd4bac9a4012af60257c030a0d8d11bbdb))


### 🐛 Bug Fixes

* **web:** sync version badges with package metadata ([b579113](https://github.com/programinglive/dev-workflow-mcp-server/commit/b5791136d60c88b9a0e08c772c0b840e481a9681))


### ✨ Features

* **workflow:** integrate mermaid feature flow and stabilize workflow logic ([88dfe56](https://github.com/programinglive/dev-workflow-mcp-server/commit/88dfe566423e12b4e76fd10231d4773254ce2c54))


### 🧹 Chores

* update commitlint dependencies and setup commiter ([6e016f9](https://github.com/programinglive/dev-workflow-mcp-server/commit/6e016f9b7c38e44bf9c91f075a1769a21f0c7f2d))

### [1.8.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.8.0...v1.8.1) (2025-12-26)


### 📝 Documentation

* add release notes for v1.8.0 ([5a4025b](https://github.com/programinglive/dev-workflow-mcp-server/commit/5a4025b8cc6bbd4aa389c7435d585ee15cd3416b))
* refresh PRD and README for v1.8.0 ([d7ff89e](https://github.com/programinglive/dev-workflow-mcp-server/commit/d7ff89eaf2c8bf89e52110f91b8b84fa26a9ceed))

## [1.8.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.17...v1.8.0) (2025-12-26)


### ♻️ Refactors

* complete handlers.js modularization and fix all tests ([af5b3d6](https://github.com/programinglive/dev-workflow-mcp-server/commit/af5b3d60db025611e9a84a27ccc78f5999d0ead7))
* split handlers.test.js into smaller focused test modules ([321bbe5](https://github.com/programinglive/dev-workflow-mcp-server/commit/321bbe50d34348202f9e096e5b1903cae519dac6))

### [1.7.17](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.16...v1.7.17) (2025-12-26)


### 📝 Documentation

* update release notes for v1.7.16 ([0afd96b](https://github.com/programinglive/dev-workflow-mcp-server/commit/0afd96b754717953eb162f65426129457fc8626e))


### ✨ Features

* allow skipping release step ([004e4fa](https://github.com/programinglive/dev-workflow-mcp-server/commit/004e4fae071e064b2c2efb9d69ecd97e794d3cb8))


### 🧹 Chores

* add @programinglive/commiter setup ([1d2a19d](https://github.com/programinglive/dev-workflow-mcp-server/commit/1d2a19d0453b50c6f0db35b15924b51a27c4891a))

### [1.7.16](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.15...v1.7.16) (2025-12-24)


### 🐛 Bug Fixes

* align database schema with dashboard and improve user ID handling ([69e7f38](https://github.com/programinglive/dev-workflow-mcp-server/commit/69e7f381955d15bb727a6e309082a344729d1c1e))


### 🧹 Chores

* cleanup temporary debugging scripts ([a5e2b15](https://github.com/programinglive/dev-workflow-mcp-server/commit/a5e2b15b894632efadce46d83caf4d008e50fdd3))
* sync version to 1.7.15 across web and landing pages ([c520e4a](https://github.com/programinglive/dev-workflow-mcp-server/commit/c520e4a5d795c880fb74f31142b128a9c55beb6f))


### 📝 Documentation

* update macOS MCP config instructions ([1e368da](https://github.com/programinglive/dev-workflow-mcp-server/commit/1e368da37bede45e0282b1312002f2fedeb6ad60))

### [1.7.15](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.14...v1.7.15) (2025-12-19)


### 🐛 Bug Fixes

* optimize startup performance and add database connection resilience ([bff2714](https://github.com/programinglive/dev-workflow-mcp-server/commit/bff27146fe9537788741e4a084191bce93588569))
* refactor Navbar and History to use absolute API client URLs v1.7.18 ([dc33eae](https://github.com/programinglive/dev-workflow-mcp-server/commit/dc33eae612067c5246ca69d08960090c0a0ad6bd))
* sync all version labels to 1.7.14 and improve netlify routing ([78712eb](https://github.com/programinglive/dev-workflow-mcp-server/commit/78712eb398458605f77b2ba78c9ff61a0be1d335))
* sync all version strings to 1.7.14 ([e2a1795](https://github.com/programinglive/dev-workflow-mcp-server/commit/e2a1795a7b794c8874b1e610de3370cd6ed5fa7a))
* sync version to 1.7.14 and fix static routing via trailingSlash ([1c152bd](https://github.com/programinglive/dev-workflow-mcp-server/commit/1c152bd23bbfd30a73e0a89107f4ea18564d20d0))

### [1.7.14](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.13...v1.7.14) (2025-12-19)


### ✨ Features

* add API dependencies and update login to use API client ([94bb42f](https://github.com/programinglive/dev-workflow-mcp-server/commit/94bb42f27b4bd225bb3813b81d5f2bff973edb16))
* add REST API server for frontend database access ([cdb347c](https://github.com/programinglive/dev-workflow-mcp-server/commit/cdb347cf204ce423b94db7e72980783e986a124d))
* implement JWT authentication and update client ([8efbe80](https://github.com/programinglive/dev-workflow-mcp-server/commit/8efbe80c3a69046f716b247fc359158dc8fec3e2))


### ♻️ Refactors

* remove session cookies, enforce JWT only ([bacd83a](https://github.com/programinglive/dev-workflow-mcp-server/commit/bacd83a16510499667143f4906d0cc8de0127d61))


### 🐛 Bug Fixes

* add credentials:include to getCurrentUser to persist session ([b8f2df5](https://github.com/programinglive/dev-workflow-mcp-server/commit/b8f2df531a2d2bae78ad3c3ea2c7dcda62e5e835))
* add root netlify.toml for monorepo support ([54c5ed3](https://github.com/programinglive/dev-workflow-mcp-server/commit/54c5ed3960aafd5a814773efa487efe9197d4385))
* enable trust proxy and force secure cookies for cross-domain session ([2c5d6e8](https://github.com/programinglive/dev-workflow-mcp-server/commit/2c5d6e858d05de06304d88286b931b1f12a95bf1))
* ensure getMe uses full API URL ([b3bd0da](https://github.com/programinglive/dev-workflow-mcp-server/commit/b3bd0da097de57b42d9253615f791677011486af))
* force API URL to tunnel address to resolve cached old IP ([1883731](https://github.com/programinglive/dev-workflow-mcp-server/commit/18837313a7b96395f1cf04b56d7fe1a74e13b1ed))
* inline auth functions in API server ([eefd73c](https://github.com/programinglive/dev-workflow-mcp-server/commit/eefd73c82dcf47d419662eaeb8854f6047e6464a))
* remove duplicate variable declarations in API server ([31d3621](https://github.com/programinglive/dev-workflow-mcp-server/commit/31d3621213ddb3560ee0570fdf6411d9acf7018f))
* remove dynamic API route for static export ([05a4dd0](https://github.com/programinglive/dev-workflow-mcp-server/commit/05a4dd0e4901e5ac329e50ebe392839d1242de4e))
* remove explicit publish path to fix netlify build ([cd64bcf](https://github.com/programinglive/dev-workflow-mcp-server/commit/cd64bcf0b4effb71be090235357d665d1f26b567))
* remove incorrect netlify publish dir for dynamic build ([ea34cf4](https://github.com/programinglive/dev-workflow-mcp-server/commit/ea34cf464466b4ddc8eaa6432434d1fbabb3583e))
* remove incorrect publish dir from netlify config ([010236f](https://github.com/programinglive/dev-workflow-mcp-server/commit/010236fd0eb1419f7cae4429159f4aac1a988174))
* restore static export for netlify deployment ([685d841](https://github.com/programinglive/dev-workflow-mcp-server/commit/685d84178b239b5cd681b4d479456e69519a8af8))
* update API URL to use Cloudflare Tunnel for HTTPS ([ab72f6c](https://github.com/programinglive/dev-workflow-mcp-server/commit/ab72f6c0b8acc6974aba7c8df8418e35da6f2a51))
* use apiClient in history page and add version indicator ([4889669](https://github.com/programinglive/dev-workflow-mcp-server/commit/48896694166cd5d42ab4134d4dbfdb0df8ca0d44))
* use npm install instead of ci to avoid lockfile issues ([e5fae26](https://github.com/programinglive/dev-workflow-mcp-server/commit/e5fae26f767c5f0e4aba2593df321c700ac14a38))


### 🧹 Chores

* bump version to 1.7.14 to ensure fresh build ([f7d8886](https://github.com/programinglive/dev-workflow-mcp-server/commit/f7d88861ceb111c57e3b34bf4b5a5cc25a19805b))
* bump version to 1.7.15 for JWT frontend deploy ([7850268](https://github.com/programinglive/dev-workflow-mcp-server/commit/7850268d019251619d60a0a841db2bab8061be04))
* cleanup post-release and update website version to 1.7.13 ([7341d44](https://github.com/programinglive/dev-workflow-mcp-server/commit/7341d446bbddcb9232e70606acaf950fde7ff5c2))
* save pending changes before release ([4d4b1c9](https://github.com/programinglive/dev-workflow-mcp-server/commit/4d4b1c9e6122baed3cc6782a572fe3700dabf19b))

### [1.7.13](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.12...v1.7.13) (2025-12-18)


### 🐛 Bug Fixes

* remote db connection, history api 500 errors, and windows startup ([ce559a6](https://github.com/programinglive/dev-workflow-mcp-server/commit/ce559a6d87f28644b3b0d5a3bad17c51bff373b7))

### [1.7.12](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.11...v1.7.12) (2025-12-17)


### 📝 Documentation

* post-release cleanup v1.7.11 ([c2ee733](https://github.com/programinglive/dev-workflow-mcp-server/commit/c2ee733bb9ec21e6ad39e564aa1fc315ca79cff6))


### ✨ Features

* add authentication system with login page and protected routes ([2acb20e](https://github.com/programinglive/dev-workflow-mcp-server/commit/2acb20efb25cddb3d2b6ee80427310c3315582dc))
* add Docker deployment support with PostgreSQL for GCP ([3adb4cb](https://github.com/programinglive/dev-workflow-mcp-server/commit/3adb4cb9ace571faf7f2138634481362c24f2730))
* expose PostgreSQL port for remote access ([b1d4066](https://github.com/programinglive/dev-workflow-mcp-server/commit/b1d40665a1c01960184508d53c0bec0b5c051e4b))
* revamp history page UI and remove history from landing ([a9d0e4e](https://github.com/programinglive/dev-workflow-mcp-server/commit/a9d0e4e70b8aa5ed3457f661cb3dbdca2d8d2a30))
* simplify docker-compose to only PostgreSQL, improve logout button UI ([4530862](https://github.com/programinglive/dev-workflow-mcp-server/commit/4530862b33178d6391ee294f74ef222843f5d5a4))


### 🐛 Bug Fixes

* suppress 401 auth errors in console ([b63e63b](https://github.com/programinglive/dev-workflow-mcp-server/commit/b63e63b60a4ba8236db1848a77d2f39f49e644b3))
* **web:** resolve 500 error on history API and auth sync ([88bbff0](https://github.com/programinglive/dev-workflow-mcp-server/commit/88bbff043f99e06a7b8ed9b9789d87d22e1f9035))


### 🧹 Chores

* configure commitlint and husky via commiter setup ([4de6c84](https://github.com/programinglive/dev-workflow-mcp-server/commit/4de6c8400b6869503bee8407bb23266779133144))
* update website to v1.7.11 and fix dependencies ([da80b1c](https://github.com/programinglive/dev-workflow-mcp-server/commit/da80b1c9d5bdf10e1387d4b2d1e98b8d2fee5e92))

### [1.7.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.10...v1.7.11) (2025-12-16)


### 📝 Documentation

* fix version status in PRD ([fa7912b](https://github.com/programinglive/dev-workflow-mcp-server/commit/fa7912ba3354a88ce943fbc9a0f34f4bd1936e34))


### ✨ Features

* implement .env support and fix mysql date persistence ([096797c](https://github.com/programinglive/dev-workflow-mcp-server/commit/096797c689813f44106a027cfa36e90d3da4bfb4))


### ✅ Tests

* comprehensive DB adapter tests, env support, and warning fixes ([44814ff](https://github.com/programinglive/dev-workflow-mcp-server/commit/44814ffcc0a1efbc8e89948de22c3b196834b390))

### [1.7.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.9...v1.7.10) (2025-12-16)


### 🧹 Chores

* update release notes and finalize ci config ([92ac78a](https://github.com/programinglive/dev-workflow-mcp-server/commit/92ac78aeefa1ced8e8a076185bb6689463a46e80))


### 📝 Documentation

* update PRD and release notes for v1.7.9 ([024b3c2](https://github.com/programinglive/dev-workflow-mcp-server/commit/024b3c25cd1703622a5f86d6eb09055ea93678d2))

### [1.7.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.8...v1.7.9) (2025-12-16)


### 🐛 Bug Fixes

* **ci:** apply official npm trusted publishing config ([9256583](https://github.com/programinglive/dev-workflow-mcp-server/commit/925658336c093c4e2fcfca30dfe469262d67c02d))

### [1.7.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.7...v1.7.8) (2025-12-16)


### 🐛 Bug Fixes

* **ci:** remove all token config for pure OIDC publishing ([d4759cc](https://github.com/programinglive/dev-workflow-mcp-server/commit/d4759ccf492396c22fa5aa0fdfbd624c571f7f42))

### [1.7.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.6...v1.7.7) (2025-12-16)


### 🐛 Bug Fixes

* **ci:** remove duplicates and apply robust trusted publishing config ([eedb661](https://github.com/programinglive/dev-workflow-mcp-server/commit/eedb661fce4461de68b636e8e7b60b4f0cf465b3))

### [1.7.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.5...v1.7.6) (2025-12-16)


### 🐛 Bug Fixes

* **ci:** restore registry config with token fallback for Trusted Publishing ([542615c](https://github.com/programinglive/dev-workflow-mcp-server/commit/542615cb95fe1aaac5f1a5be18694a7577b8eb86))

### [1.7.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.4...v1.7.5) (2025-12-16)


### 🐛 Bug Fixes

* **ci:** switch to tokenless trusted publishing ([fdfc4a9](https://github.com/programinglive/dev-workflow-mcp-server/commit/fdfc4a9a86485ee60f0f650e16aa9195671d9ab3))

### [1.7.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.3...v1.7.4) (2025-12-16)


### 🐛 Bug Fixes

* **ci:** add id-token permission for npm provenance ([8930338](https://github.com/programinglive/dev-workflow-mcp-server/commit/8930338aaf90616f1c741c4634ac8e96d3c43fb7))

### [1.7.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.2...v1.7.3) (2025-12-16)


### 🐛 Bug Fixes

* **ci:** add web dependencies installation step ([7d5dc62](https://github.com/programinglive/dev-workflow-mcp-server/commit/7d5dc62a213d3105c2329a1fb810cc6260fe4815))

### [1.7.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.1...v1.7.2) (2025-12-16)


### 🐛 Bug Fixes

* **ci:** consolidate release and publish workflows ([98e5b31](https://github.com/programinglive/dev-workflow-mcp-server/commit/98e5b31fb64e39b1c846ce594215fb38ab13bf19))

### [1.7.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.7.0...v1.7.1) (2025-12-16)


### 🐛 Bug Fixes

* build errors and warnings ([dc24831](https://github.com/programinglive/dev-workflow-mcp-server/commit/dc2483188a58d932590503ec2058c51e3de78d0b))
* suppress remaining build warnings ([f7d9b2d](https://github.com/programinglive/dev-workflow-mcp-server/commit/f7d9b2d9fb695e6699d65456747c21a301b62fee))

## [1.7.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.6.3...v1.7.0) (2025-12-16)


### 🐛 Bug Fixes

* handle null CustPL in birthday-customers.blade.php (ERP-19) ([71b8f7e](https://github.com/programinglive/dev-workflow-mcp-server/commit/71b8f7ebbf83266008e28446630be97ae24e1d64))


### ♻️ Refactors

* integrate database adapters into workflow state ([370cbb4](https://github.com/programinglive/dev-workflow-mcp-server/commit/370cbb416b49c758239177296978f7deba5e49e2))


### 📝 Documentation

* update PRD and add configuration guide ([1dfccf5](https://github.com/programinglive/dev-workflow-mcp-server/commit/1dfccf5e37eee2994acaf9067320cf13a64fd515))
* update release notes for 1.6.3 ([afb9fb9](https://github.com/programinglive/dev-workflow-mcp-server/commit/afb9fb9b4c14be0a9f8ecfada3bb72ca75b7f116))


### 🧹 Chores

* add mysql2 and pg dependencies ([94423d7](https://github.com/programinglive/dev-workflow-mcp-server/commit/94423d72aab3cb1c2ee47d9a4995e05cceda1f11))
* **release:** null 🚀 ([93a17e2](https://github.com/programinglive/dev-workflow-mcp-server/commit/93a17e26f1995fda34d2ae40f61f39b697dc03bf))
* **release:** null 🚀 ([033097e](https://github.com/programinglive/dev-workflow-mcp-server/commit/033097eecd04b2dd3f9299d497ebe71d32f470b9))
* **release:** null 🚀 ([91c800a](https://github.com/programinglive/dev-workflow-mcp-server/commit/91c800a584f4b967fe60b8058684d5224543f26b))
* **release:** null 🚀 ([f0958c4](https://github.com/programinglive/dev-workflow-mcp-server/commit/f0958c40f187c0bd4ff77cb2f628fb2338dafa6b))
* **release:** null 🚀 ([ac3cc6e](https://github.com/programinglive/dev-workflow-mcp-server/commit/ac3cc6e8a5dea2d119c072fbb8029947e234643c))
* **release:** null 🚀 ([f3f9a00](https://github.com/programinglive/dev-workflow-mcp-server/commit/f3f9a00059c435d2e18940f8a4b41e166a779ff3))
* **release:** null 🚀 ([bcf7d95](https://github.com/programinglive/dev-workflow-mcp-server/commit/bcf7d9560af34b0a257bfe6566a0cd1572ebb5d1))
* **release:** null 🚀 ([74df6d6](https://github.com/programinglive/dev-workflow-mcp-server/commit/74df6d6d2972ab2c4702da7e773ab651a41daaa3))
* **release:** null 🚀 ([0d9dc4d](https://github.com/programinglive/dev-workflow-mcp-server/commit/0d9dc4d3ba751bbe69aecf6221eb79ea2f54ccd9))
* **release:** null 🚀 ([9667012](https://github.com/programinglive/dev-workflow-mcp-server/commit/966701266afec03b6f621670d2217b98c1a85eb1))
* **release:** null 🚀 ([db25d0c](https://github.com/programinglive/dev-workflow-mcp-server/commit/db25d0c9117e00d20584a5a175a727f16219bfe9))
* **release:** null 🚀 ([50d5353](https://github.com/programinglive/dev-workflow-mcp-server/commit/50d535373b080de2b765b0ac9c32ce6f7d4a55f7))
* **release:** null 🚀 ([ee0a540](https://github.com/programinglive/dev-workflow-mcp-server/commit/ee0a54097cc481c2aeb74ca99a41b34914ab540f))
* **release:** null 🚀 ([92558af](https://github.com/programinglive/dev-workflow-mcp-server/commit/92558af18f41169760dfbe069f32c9e4969b656d))
* **release:** null 🚀 ([cd851ac](https://github.com/programinglive/dev-workflow-mcp-server/commit/cd851ac6d3ddd91286b63a83d05a1a5a5a17aee6))
* **release:** null 🚀 ([49ec562](https://github.com/programinglive/dev-workflow-mcp-server/commit/49ec5629b8308dc9ed19672b07966c3711748817))
* **release:** null 🚀 ([bcc7a3c](https://github.com/programinglive/dev-workflow-mcp-server/commit/bcc7a3c1a554dbea2dce16585ef926bed925e062))


### ✨ Features

* implement database adapters for sqlite, mysql, postgres ([8e7416a](https://github.com/programinglive/dev-workflow-mcp-server/commit/8e7416a467286eaa26051e8e0b4af5f350295087))
* persist active workflow state to database ([d29546d](https://github.com/programinglive/dev-workflow-mcp-server/commit/d29546dee52940170a9a855146ca870fa078cf66))

### [1.6.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.6.2...v1.6.3) (2025-12-06)


### 📝 Documentation

* update release notes for 1.6.2 ([f0c2d49](https://github.com/programinglive/dev-workflow-mcp-server/commit/f0c2d4965f3e08afdaccae5eb49f7ea7d21a6ed3))


### 🐛 Bug Fixes

* add light mode support to docs page ([490cf22](https://github.com/programinglive/dev-workflow-mcp-server/commit/490cf2210253a7498cbb3d3a33d1c329672a2dfa))

### [1.6.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.6.1...v1.6.2) (2025-12-06)


### 📝 Documentation

* update release notest for 1.6.1 ([72a9284](https://github.com/programinglive/dev-workflow-mcp-server/commit/72a92847444436e2c4bd17407e664117fe08a31f))


### ✅ Tests

* update create_documentation test to verify PRD check and remove incompatible jest test ([a7f2b28](https://github.com/programinglive/dev-workflow-mcp-server/commit/a7f2b28e65116cfb556767e7e6b25c0b4cdba613))


### ✨ Features

* add PRD file existence check to create_documentation workflow step ([62cdee3](https://github.com/programinglive/dev-workflow-mcp-server/commit/62cdee3f7402ed70e3e36003020e84958cdd4a3d))
* add PRD file existence check to create_documentation workflow step ([6c51012](https://github.com/programinglive/dev-workflow-mcp-server/commit/6c510121980789c3d0e96376fe0375fbaf78a656))

### [1.6.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.6.0...v1.6.1) (2025-12-06)


### 🐛 Bug Fixes

* add table header to release notes for release script compatibility ([44e47fc](https://github.com/programinglive/dev-workflow-mcp-server/commit/44e47fc49ee9334cad82df095de1277038d0a0e9))

## [1.6.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.11...v1.6.0) (2025-12-06)


### ✨ Features

* add responsive vertical monitor support and dark/light mode toggle ([5565765](https://github.com/programinglive/dev-workflow-mcp-server/commit/5565765f5e5db63d5239c9b82371ae1853a72085))

### [1.5.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.10...v1.5.11) (2025-12-05)

### [1.5.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.9...v1.5.10) (2025-12-05)

### [1.5.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.8...v1.5.9) (2025-12-05)

### [1.5.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.7...v1.5.8) (2025-12-05)


### 🐛 Bug Fixes

* **release:** amend tag to include release notes, remove build-docs.js and dist/docs ([a3cea9b](https://github.com/programinglive/dev-workflow-mcp-server/commit/a3cea9b612ee2d8f970bf7dd93bcbeef98ba0924))

### [1.5.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.6...v1.5.7) (2025-12-05)


### 🐛 Bug Fixes

* **ci:** checkout main branch for release notes and remove RELEASE_NOTES.html generation ([5d50dc0](https://github.com/programinglive/dev-workflow-mcp-server/commit/5d50dc0597f1a9a60dde00cde876f3324bee6062))

### [1.5.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.5...v1.5.6) (2025-12-05)


### 🐛 Bug Fixes

* **ci:** update github release workflow to use github-script ([0990808](https://github.com/programinglive/dev-workflow-mcp-server/commit/099080891975f64088979ba69d78b305c5469613))

### [1.5.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.4...v1.5.5) (2025-12-05)


### 📝 Documentation

* add unreleased note for release automation ([a5478dc](https://github.com/programinglive/dev-workflow-mcp-server/commit/a5478dc5c65c3fb64576d254f9018ebe518a0c3f))

### [1.5.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.3...v1.5.4) (2025-12-05)


### 🧹 Chores

* **ci:** add github release automation workflow ([80d5ded](https://github.com/programinglive/dev-workflow-mcp-server/commit/80d5ded7e2be8f45c02d65c5564934c73262bc4c))
* **release:** version 1.5.3 changes and changelog ([c2698a7](https://github.com/programinglive/dev-workflow-mcp-server/commit/c2698a7cf55acf5251b423f512621de5802ba09a))
* run release scripts via cjs ([bc241c8](https://github.com/programinglive/dev-workflow-mcp-server/commit/bc241c80bc1ec7d9ffa4c7f2982d6cecf19853c1))
* **web:** update version display to 1.5.3 in docs page ([25e37f3](https://github.com/programinglive/dev-workflow-mcp-server/commit/25e37f3c7dab550de37f79d5c31bd0395251489c))
* **web:** update version display to 1.5.3 in Hero component ([b478449](https://github.com/programinglive/dev-workflow-mcp-server/commit/b478449b334beedafb13fa0bec4b3cf6e9739f81))

### [1.5.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.2...v1.5.3) (2025-12-05)


### 🐛 Bug Fixes

* correct package.json version from null to 1.5.2 for npm publish ([be60c99](https://github.com/programinglive/dev-workflow-mcp-server/commit/be60c99f1e79cdaf5d3b9cb7c780edd30356f420))
* **news:** improve error handling and form accessibility ([5e0a1a8](https://github.com/programinglive/dev-workflow-mcp-server/commit/5e0a1a83ae18054f967ff9041c7ed81fd7d6d4eb))
* switch to static export for Netlify deployment ([acddfd7](https://github.com/programinglive/dev-workflow-mcp-server/commit/acddfd78da86859febdb1c46b04a5e79fd8f176f))


### 🧹 Chores

* **release:** null 🚀 ([55d7f99](https://github.com/programinglive/dev-workflow-mcp-server/commit/55d7f9980ea8f188d284facb7c9d1d5d4a6d6210))
* **release:** prepare patch release 1.5.3 ([5b92c42](https://github.com/programinglive/dev-workflow-mcp-server/commit/5b92c4215e4188a3dc6714d3f2999c65f460d2c9))

### [1.5.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.1...v1.5.2) (2025-12-02)

### [1.5.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.5.0...v1.5.1) (2025-12-02)


### 🏗️ Build System

* add netlify.toml for static site deployment ([8667537](https://github.com/programinglive/dev-workflow-mcp-server/commit/8667537baf16889b830c46d3ffde5770589f868f))


### ✨ Features

* add Netlify deployment support for web dashboard ([c05a791](https://github.com/programinglive/dev-workflow-mcp-server/commit/c05a791b3dac12d708e971061c48d3783733f985))


### 📝 Documentation

* update generated web-dashboard.html ([96d47a5](https://github.com/programinglive/dev-workflow-mcp-server/commit/96d47a52a658b105d4d094e18156a8cfc2d13854))
* update release notes for 1.5.0 ([d860460](https://github.com/programinglive/dev-workflow-mcp-server/commit/d860460826d179e94524807b1776f60854c1db4c))

## [1.5.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.6...v1.5.0) (2025-12-02)


### ♻️ Refactors

* **dashboard:** combine analytics charts and use local Chart.js ([86ed3f4](https://github.com/programinglive/dev-workflow-mcp-server/commit/86ed3f4a88570b2f580cb1408e459da681288254))


### ✨ Features

* **dashboard:** implement random data generation for analytics chart ([17e2073](https://github.com/programinglive/dev-workflow-mcp-server/commit/17e20737b719392a2bd90cb1a6f4cc6084b54ab5))


### 🐛 Bug Fixes

* **dashboard:** improve responsive layout for admin stats cards ([33d5b39](https://github.com/programinglive/dev-workflow-mcp-server/commit/33d5b3929ffda733d2328d1e9214c17c1e3d2b40))
* **dashboard:** improve responsive layout for admin stats cards ([530400d](https://github.com/programinglive/dev-workflow-mcp-server/commit/530400d6ce266d151c617b4b2c7ea56cb1b15042))
* move build dependencies to dependencies section ([701b07c](https://github.com/programinglive/dev-workflow-mcp-server/commit/701b07c91d31007bc63899a8ddd6350773d4704f))
* move dompdf to require and resolve debugbar production error ([e5d1cb6](https://github.com/programinglive/dev-workflow-mcp-server/commit/e5d1cb68f70f0980fbbd69f914b76bf0fb09af18))
* move vite to dependencies to ensure build works on production ([62fc4c0](https://github.com/programinglive/dev-workflow-mcp-server/commit/62fc4c0fecf3ef4cfce231a2663bc67d34668c25))
* resolve sentry permission issues ([c739f8e](https://github.com/programinglive/dev-workflow-mcp-server/commit/c739f8e2bc5b99d70d63dbc66cefc3fa3b187651))


### 🧹 Chores

* align MCP registry schema and docs ([e4e732d](https://github.com/programinglive/dev-workflow-mcp-server/commit/e4e732d6149a63ddf327ffb741f94d90103c903b))
* **release:** 1.4.10 🚀 ([74fa5c1](https://github.com/programinglive/dev-workflow-mcp-server/commit/74fa5c11e44bf9c3b29981314c4d13469691fab2))
* **release:** 1.4.11 🚀 ([28c7a62](https://github.com/programinglive/dev-workflow-mcp-server/commit/28c7a62422d247369ea6652d0bf31b874534a1e4))
* **release:** 1.4.7 🚀 ([ab4c218](https://github.com/programinglive/dev-workflow-mcp-server/commit/ab4c2184a4fe5e410f54d3723af247ecb0d06f28))
* **release:** 1.4.8 🚀 ([b60681b](https://github.com/programinglive/dev-workflow-mcp-server/commit/b60681b801be01919711302be38fb6e576f99a8b))
* **release:** 1.4.9 🚀 ([3f73564](https://github.com/programinglive/dev-workflow-mcp-server/commit/3f73564197068b6a055d36df560322150c0ba6b4))
* remove web-legacy ([5f0d29e](https://github.com/programinglive/dev-workflow-mcp-server/commit/5f0d29e087918e6891b7e41aa58e262c710d4a67))


### 📝 Documentation

* update release notes html for 1.4.11 ([e683ab6](https://github.com/programinglive/dev-workflow-mcp-server/commit/e683ab6b06bfd5bbcc2dbd6441c9d121bec74feb))

### [1.4.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.10...v1.4.11) (2025-12-01)


### 🐛 Bug Fixes

* move vite to dependencies to ensure build works on production ([62fc4c0](https://github.com/programinglive/dev-workflow-mcp-server/commit/62fc4c0fecf3ef4cfce231a2663bc67d34668c25))
* resolve sentry permission issues ([c739f8e](https://github.com/programinglive/dev-workflow-mcp-server/commit/c739f8e2bc5b99d70d63dbc66cefc3fa3b187651))

### [1.4.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.9...v1.4.10) (2025-12-01)


### ✨ Features

* **dashboard:** implement random data generation for analytics chart ([17e2073](https://github.com/programinglive/dev-workflow-mcp-server/commit/17e20737b719392a2bd90cb1a6f4cc6084b54ab5))


### 🐛 Bug Fixes

* move dompdf to require and resolve debugbar production error ([e5d1cb6](https://github.com/programinglive/dev-workflow-mcp-server/commit/e5d1cb68f70f0980fbbd69f914b76bf0fb09af18))

### [1.4.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.8...v1.4.9) (2025-11-30)


### ♻️ Refactors

* **dashboard:** combine analytics charts and use local Chart.js ([86ed3f4](https://github.com/programinglive/dev-workflow-mcp-server/commit/86ed3f4a88570b2f580cb1408e459da681288254))

### [1.4.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.7...v1.4.8) (2025-11-30)


### 🐛 Bug Fixes

* **dashboard:** improve responsive layout for admin stats cards ([33d5b39](https://github.com/programinglive/dev-workflow-mcp-server/commit/33d5b3929ffda733d2328d1e9214c17c1e3d2b40))
* **dashboard:** improve responsive layout for admin stats cards ([530400d](https://github.com/programinglive/dev-workflow-mcp-server/commit/530400d6ce266d151c617b4b2c7ea56cb1b15042))

### [1.4.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.3...v1.4.7) (2025-11-29)


### ✨ Features

* add core doc types (PRD/README/RELEASE_NOTES) and fix CI build ([8ed0567](https://github.com/programinglive/dev-workflow-mcp-server/commit/8ed0567e8de772b95de6fb744a936b07ed3e1c32))
* update hero text and meta description to emphasize Indonesian programmer community ([681547b](https://github.com/programinglive/dev-workflow-mcp-server/commit/681547b764b2fcf3a874cc637d9653c12bf62640))


### 🐛 Bug Fixes

* display dynamic version in web dashboard from /api/version ([69f561d](https://github.com/programinglive/dev-workflow-mcp-server/commit/69f561d369fa8347399fafe5dcdb3a2dbb485064))


### 🧹 Chores

* add 1.4.3 release notes ([8b165f7](https://github.com/programinglive/dev-workflow-mcp-server/commit/8b165f7a8201f6b8484dce60f3f907cb195abb83))
* add MCP registry metadata (mcpName & server.json) ([66caea1](https://github.com/programinglive/dev-workflow-mcp-server/commit/66caea1d684473cfc916917faa42e16fc4ad9e14))
* align MCP registry schema and docs ([e4e732d](https://github.com/programinglive/dev-workflow-mcp-server/commit/e4e732d6149a63ddf327ffb741f94d90103c903b))
* **release:** 1.4.4 🚀 ([05a968f](https://github.com/programinglive/dev-workflow-mcp-server/commit/05a968fd08ca41e50d324893d993cb5117b2575c))
* **release:** 1.4.5 🚀 ([7e823b9](https://github.com/programinglive/dev-workflow-mcp-server/commit/7e823b993c04c5372b4c6acbdf58c713458e8881))
* **release:** 1.4.6 🚀 ([7e0b672](https://github.com/programinglive/dev-workflow-mcp-server/commit/7e0b67208756b2e6bb34f61ff0382022979b294e))

### [1.4.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.5...v1.4.6) (2025-11-27)


### 🧹 Chores

* add MCP registry metadata (mcpName & server.json) ([66caea1](https://github.com/programinglive/dev-workflow-mcp-server/commit/66caea1d684473cfc916917faa42e16fc4ad9e14))

### [1.4.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.4...v1.4.5) (2025-11-27)


### 🐛 Bug Fixes

* display dynamic version in web dashboard from /api/version ([69f561d](https://github.com/programinglive/dev-workflow-mcp-server/commit/69f561d369fa8347399fafe5dcdb3a2dbb485064))

### [1.4.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.1...v1.4.4) (2025-11-27)


### ♻️ Refactors

* consolidate workflow state to root .state folder only ([3d69a14](https://github.com/programinglive/dev-workflow-mcp-server/commit/3d69a14e2abd7897bc91ede5e3c484b90eefc726))


### 🐛 Bug Fixes

* ensure release guard uses freshest workflow state ([e07eb42](https://github.com/programinglive/dev-workflow-mcp-server/commit/e07eb42179f17f2da282bff70392ce1b4652346a))
* remove invalid turbopack experimental config from next.config.ts ([af0a7ea](https://github.com/programinglive/dev-workflow-mcp-server/commit/af0a7ea7906654755a2520693fd81d7fb6633c13))
* **web:** configure next.js root to silence warnings ([22ed002](https://github.com/programinglive/dev-workflow-mcp-server/commit/22ed00256a4c6d7dbca13d2733baf0f4392b6650))
* **web:** improve mobile layout for hero section ([53b26bf](https://github.com/programinglive/dev-workflow-mcp-server/commit/53b26bf3271cab3ac029be8ddb72a8d5312b150e))


### 📝 Documentation

* add Plesk deployment guide ([de35675](https://github.com/programinglive/dev-workflow-mcp-server/commit/de356753231d1bb29fd3c87fdd9d095932fae4b0))


### 🧹 Chores

* add 1.4.3 release notes ([8b165f7](https://github.com/programinglive/dev-workflow-mcp-server/commit/8b165f7a8201f6b8484dce60f3f907cb195abb83))
* fix release state detection ([ed5dfd1](https://github.com/programinglive/dev-workflow-mcp-server/commit/ed5dfd15d296c555bd5c2731267a87ad4a371af9))
* prepare for release ([a6ea2d0](https://github.com/programinglive/dev-workflow-mcp-server/commit/a6ea2d0c44f35f2a1e06c4e01bbe026177e9cff2))
* **release:** 1.4.2 ([fac8999](https://github.com/programinglive/dev-workflow-mcp-server/commit/fac899992d370c0198954a6f7c97ab7645514e25))
* **release:** 1.4.2 🚀 ([01b0b3c](https://github.com/programinglive/dev-workflow-mcp-server/commit/01b0b3c791c10b76c05bae01e4e8c5ce7435ce14))
* **release:** 1.4.3 🚀 ([04d8c3b](https://github.com/programinglive/dev-workflow-mcp-server/commit/04d8c3b2873ce819633c95a12f6c48e73fe671ea))
* update task list ([35663dd](https://github.com/programinglive/dev-workflow-mcp-server/commit/35663dd661d3b97a5fedb5013fbbca36e75605d8))
* **web:** fix next.js lockfile warning ([05ffce0](https://github.com/programinglive/dev-workflow-mcp-server/commit/05ffce0b171cb804c6a14223521cd1fa876b80ae))


### ✨ Features

* add core doc types (PRD/README/RELEASE_NOTES) and fix CI build ([8ed0567](https://github.com/programinglive/dev-workflow-mcp-server/commit/8ed0567e8de772b95de6fb744a936b07ed3e1c32))
* update hero text and meta description to emphasize Indonesian programmer community ([681547b](https://github.com/programinglive/dev-workflow-mcp-server/commit/681547b764b2fcf3a874cc637d9653c12bf62640))
* update program tracks and fix fast refresh warning ([aa5bc9c](https://github.com/programinglive/dev-workflow-mcp-server/commit/aa5bc9cbc8a9bf9c9552e00e89b0b97ddeac0592))

### [1.4.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.2...v1.4.3) (2025-11-27)


### 🧹 Chores

* **release:** 1.4.2 ([fac8999](https://github.com/programinglive/dev-workflow-mcp-server/commit/fac899992d370c0198954a6f7c97ab7645514e25))


### 🐛 Bug Fixes

* remove invalid turbopack experimental config from next.config.ts ([af0a7ea](https://github.com/programinglive/dev-workflow-mcp-server/commit/af0a7ea7906654755a2520693fd81d7fb6633c13))


### 📝 Documentation

* add Plesk deployment guide ([de35675](https://github.com/programinglive/dev-workflow-mcp-server/commit/de356753231d1bb29fd3c87fdd9d095932fae4b0))


### ✨ Features

* update program tracks and fix fast refresh warning ([aa5bc9c](https://github.com/programinglive/dev-workflow-mcp-server/commit/aa5bc9cbc8a9bf9c9552e00e89b0b97ddeac0592))

### [1.4.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.1...v1.4.2) (2025-11-27)


### 🧹 Chores

* fix release state detection ([ed5dfd1](https://github.com/programinglive/dev-workflow-mcp-server/commit/ed5dfd15d296c555bd5c2731267a87ad4a371af9))
* prepare for release ([a6ea2d0](https://github.com/programinglive/dev-workflow-mcp-server/commit/a6ea2d0c44f35f2a1e06c4e01bbe026177e9cff2))
* update task list ([35663dd](https://github.com/programinglive/dev-workflow-mcp-server/commit/35663dd661d3b97a5fedb5013fbbca36e75605d8))
* **web:** fix next.js lockfile warning ([05ffce0](https://github.com/programinglive/dev-workflow-mcp-server/commit/05ffce0b171cb804c6a14223521cd1fa876b80ae))


### 🐛 Bug Fixes

* ensure release guard uses freshest workflow state ([e07eb42](https://github.com/programinglive/dev-workflow-mcp-server/commit/e07eb42179f17f2da282bff70392ce1b4652346a))
* **web:** configure next.js root to silence warnings ([22ed002](https://github.com/programinglive/dev-workflow-mcp-server/commit/22ed00256a4c6d7dbca13d2733baf0f4392b6650))
* **web:** improve mobile layout for hero section ([53b26bf](https://github.com/programinglive/dev-workflow-mcp-server/commit/53b26bf3271cab3ac029be8ddb72a8d5312b150e))


### ♻️ Refactors

* consolidate workflow state to root .state folder only ([3d69a14](https://github.com/programinglive/dev-workflow-mcp-server/commit/3d69a14e2abd7897bc91ede5e3c484b90eefc726))

### [1.4.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.4.0...v1.4.1) (2025-11-27)


### 🐛 Bug Fixes

* update build test to include postbuild ([b1e2f48](https://github.com/programinglive/dev-workflow-mcp-server/commit/b1e2f481334df825109e3f2934c88b8f14c1b4d0))


### ✨ Features

* add custom server.js for Plesk ([b3912cd](https://github.com/programinglive/dev-workflow-mcp-server/commit/b3912cdaf50085ae30cab553a9ebac2b7281ee28))

## [1.4.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.12...v1.4.0) (2025-11-26)


### ✨ Features

* migrate dashboard to Next.js with TypeScript and Tailwind CSS ([bce1fec](https://github.com/programinglive/dev-workflow-mcp-server/commit/bce1fec98a7b5e5542644271a77ccaf1019dd83c))


### 🧹 Chores

* fix package.json scripts ([fb25e98](https://github.com/programinglive/dev-workflow-mcp-server/commit/fb25e98c763d4b5cac5c321f56a2e533577fc38b))
* fix tsconfig and remove dist artifact ([282759f](https://github.com/programinglive/dev-workflow-mcp-server/commit/282759f14de6231ad6374dc891b551ca0d70ac28))

### [1.3.12](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.11...v1.3.12) (2025-11-22)


### 🐛 Bug Fixes

* **scripts:** update release notes script and backfill versions ([808791e](https://github.com/programinglive/dev-workflow-mcp-server/commit/808791ec4a988fe557fa82be21fb92f6a34d792c))
* **scripts:** update release notes script to support header format and backfill versions ([e4a5055](https://github.com/programinglive/dev-workflow-mcp-server/commit/e4a5055633ba4d83d43c85ee8b475cd761685519))

### [1.3.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.10...v1.3.11) (2025-11-22)


### ♻️ Refactors

* **web:** move static files to public/ subdirectory for Plesk security ([3e5c321](https://github.com/programinglive/dev-workflow-mcp-server/commit/3e5c321d569e3594d9f29c8762513b95df8dbd84))

### [1.3.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.9...v1.3.10) (2025-11-22)


### 📝 Documentation

* add workflow best practices to eliminate forced releases ([6bcac42](https://github.com/programinglive/dev-workflow-mcp-server/commit/6bcac42bc9f30cbfa0a27e36a90af303d244d863))

### [1.3.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.8...v1.3.9) (2025-11-22)


### ✨ Features

* **web:** improve documentation modal layout and readability ([ca033bd](https://github.com/programinglive/dev-workflow-mcp-server/commit/ca033bd1208283c46a6262b6f447f57246c19dc7))


### 🧹 Chores

* rebuild Tailwind CSS ([b8a552e](https://github.com/programinglive/dev-workflow-mcp-server/commit/b8a552ebec854b4a50265fc9979c350a46a594ca))

### [1.3.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.7...v1.3.8) (2025-11-22)


### 🐛 Bug Fixes

* **web:** track dist/docs in git for production deployment ([95a9e87](https://github.com/programinglive/dev-workflow-mcp-server/commit/95a9e8792e7045a86435b6df0d44f31d6b9952f1))

### [1.3.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.6...v1.3.7) (2025-11-22)


### 🐛 Bug Fixes

* **web:** downgrade to Tailwind v3 for CSS generation ([74c2abd](https://github.com/programinglive/dev-workflow-mcp-server/commit/74c2abdc7d87d956eb5a6f4f109cd8504a3e258a))

### [1.3.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.5...v1.3.6) (2025-11-22)


### ✨ Features

* **web:** replace Tailwind CDN with build process ([1e6e91f](https://github.com/programinglive/dev-workflow-mcp-server/commit/1e6e91f880d0445e39211d0d42aff1ca2e3e9253))

### [1.3.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.4...v1.3.5) (2025-11-22)


### 🐛 Bug Fixes

* sync package-lock.json with dependencies ([c3f3b5c](https://github.com/programinglive/dev-workflow-mcp-server/commit/c3f3b5c21e2bc919daf51c8e68209eaba7314bc9))

### [1.3.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.3...v1.3.4) (2025-11-22)


### 🐛 Bug Fixes

* move marked to dependencies for production build ([15b9a93](https://github.com/programinglive/dev-workflow-mcp-server/commit/15b9a932d822c0b12206642cbbc24c020453fdc4))

### [1.3.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.2...v1.3.3) (2025-11-22)


### ✨ Features

* **web:** add version display to dashboard ([cb412bf](https://github.com/programinglive/dev-workflow-mcp-server/commit/cb412bf03f015e9549c09d967463790bb3564bc3))

### [1.3.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.1...v1.3.2) (2025-11-22)


### ✨ Features

* **web:** update dashboard with new documentation links ([57c4b9a](https://github.com/programinglive/dev-workflow-mcp-server/commit/57c4b9ab0b13fd3a2a5e4d04a758be20d0de9f04))

### [1.3.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.3.0...v1.3.1) (2025-11-22)


### 📝 Documentation

* move release notes to docs/release-notes/ and update missing versions ([67119fc](https://github.com/programinglive/dev-workflow-mcp-server/commit/67119fc59547efe57bf80d70134f111f5c86a7a5))


### 🐛 Bug Fixes

* update package.json release scripts to point to release-wrapper.js ([5b30015](https://github.com/programinglive/dev-workflow-mcp-server/commit/5b30015224b7904bf9ef73497c68047ad3843a0f))

## [1.3.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.7...v1.3.0) (2025-11-22)


### 🧹 Chores

* integrate @programinglive/commiter package for automated release management ([ab114df](https://github.com/programinglive/dev-workflow-mcp-server/commit/ab114df70fa3d401227ab78c7bf794d38a92fee4))


### 🐛 Bug Fixes

* convert release scripts to CJS to support ESM project ([3162905](https://github.com/programinglive/dev-workflow-mcp-server/commit/3162905820c2d413cfc396c5f476d84d814aa4ec))
* use double quotes for Windows shell escaping in cmd.exe ([3f0b21b](https://github.com/programinglive/dev-workflow-mcp-server/commit/3f0b21be2e36a5ec2914649515f019aaec594ad8))

### [1.2.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.6...v1.2.7) (2025-11-13)

### [1.2.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.5...v1.2.6) (2025-11-11)


### 🏗️ Build System

* **release:** delegate to commiter ([e174d8d](https://github.com/programinglive/dev-workflow-mcp-server/commit/e174d8dca300e4822f67681a39dc5f4d9f56232a))


### 🐛 Bug Fixes

* **cli:** expose primary branch helper ([a3fb9c8](https://github.com/programinglive/dev-workflow-mcp-server/commit/a3fb9c881df67298eba4a8446ba9a14473f54e0a))


### 📝 Documentation

* **changelog:** note commiter delegation ([6352aa2](https://github.com/programinglive/dev-workflow-mcp-server/commit/6352aa2f561e9d7f7d8a4f26d9c930e108bbe81b))

### [1.2.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.3...v1.2.4) (2025-11-11)


### ✨ Features

* **docs:** prebuild markdown docs ([84272b6](https://github.com/programinglive/dev-workflow-mcp-server/commit/84272b690e7da88cab60f3b29449044d875261d6))

### [1.2.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.2...v1.2.3) (2025-11-11)


### ✨ Features

* **web:** highlight 20 MCP tools on dashboard ([eb76634](https://github.com/programinglive/dev-workflow-mcp-server/commit/eb766347bff18cc780e4f86b8d70a122eab3307f))

### [1.2.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.1...v1.2.6) (2025-11-11)


### 🧹 Chores

* **release:** 1.2.2 🚀 ([64eb9de](https://github.com/programinglive/dev-workflow-mcp-server/commit/64eb9dea66625ce0b21b5006f455b0d452299997))
* **release:** 1.2.3 🚀 ([cd113e9](https://github.com/programinglive/dev-workflow-mcp-server/commit/cd113e9a2ca7a8a374f2ec07aa4a25f1c0570051))
* **release:** 1.2.4 🚀 ([7d39809](https://github.com/programinglive/dev-workflow-mcp-server/commit/7d398091359ee74c69f12e8fa77443615c32d51a))
* **release:** 1.2.5 🚀 ([e893f26](https://github.com/programinglive/dev-workflow-mcp-server/commit/e893f26a173306f96a40f68bf2c71706cc5fdb77))


### 📝 Documentation

* clarify user ID management ([a76381c](https://github.com/programinglive/dev-workflow-mcp-server/commit/a76381c842c1dea5e98116667addc4cbd0d022ed))

### [1.2.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.1...v1.2.5) (2025-11-11)


### 🧹 Chores

* **release:** 1.2.2 🚀 ([64eb9de](https://github.com/programinglive/dev-workflow-mcp-server/commit/64eb9dea66625ce0b21b5006f455b0d452299997))
* **release:** 1.2.3 🚀 ([cd113e9](https://github.com/programinglive/dev-workflow-mcp-server/commit/cd113e9a2ca7a8a374f2ec07aa4a25f1c0570051))
* **release:** 1.2.4 🚀 ([7d39809](https://github.com/programinglive/dev-workflow-mcp-server/commit/7d398091359ee74c69f12e8fa77443615c32d51a))
* **release:** 1.2.5 🚀 ([e893f26](https://github.com/programinglive/dev-workflow-mcp-server/commit/e893f26a173306f96a40f68bf2c71706cc5fdb77))


### 📝 Documentation

* clarify user ID management ([a76381c](https://github.com/programinglive/dev-workflow-mcp-server/commit/a76381c842c1dea5e98116667addc4cbd0d022ed))

### [1.2.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.1...v1.2.4) (2025-11-11)


### 🧹 Chores

* **release:** 1.2.2 🚀 ([64eb9de](https://github.com/programinglive/dev-workflow-mcp-server/commit/64eb9dea66625ce0b21b5006f455b0d452299997))
* **release:** 1.2.3 🚀 ([cd113e9](https://github.com/programinglive/dev-workflow-mcp-server/commit/cd113e9a2ca7a8a374f2ec07aa4a25f1c0570051))
* **release:** 1.2.4 🚀 ([7d39809](https://github.com/programinglive/dev-workflow-mcp-server/commit/7d398091359ee74c69f12e8fa77443615c32d51a))
* **release:** 1.2.5 🚀 ([e893f26](https://github.com/programinglive/dev-workflow-mcp-server/commit/e893f26a173306f96a40f68bf2c71706cc5fdb77))


### 📝 Documentation

* clarify user ID management ([a76381c](https://github.com/programinglive/dev-workflow-mcp-server/commit/a76381c842c1dea5e98116667addc4cbd0d022ed))

### [1.2.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.1...v1.2.3) (2025-11-11)


### 🧹 Chores

* **release:** 1.2.2 🚀 ([64eb9de](https://github.com/programinglive/dev-workflow-mcp-server/commit/64eb9dea66625ce0b21b5006f455b0d452299997))
* **release:** 1.2.3 🚀 ([cd113e9](https://github.com/programinglive/dev-workflow-mcp-server/commit/cd113e9a2ca7a8a374f2ec07aa4a25f1c0570051))
* **release:** 1.2.4 🚀 ([7d39809](https://github.com/programinglive/dev-workflow-mcp-server/commit/7d398091359ee74c69f12e8fa77443615c32d51a))
* **release:** 1.2.5 🚀 ([e893f26](https://github.com/programinglive/dev-workflow-mcp-server/commit/e893f26a173306f96a40f68bf2c71706cc5fdb77))


### 📝 Documentation

* clarify user ID management ([a76381c](https://github.com/programinglive/dev-workflow-mcp-server/commit/a76381c842c1dea5e98116667addc4cbd0d022ed))

### [1.2.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.1...v1.2.2) (2025-11-11)


### 🧹 Chores

* **release:** 1.2.2 🚀 ([64eb9de](https://github.com/programinglive/dev-workflow-mcp-server/commit/64eb9dea66625ce0b21b5006f455b0d452299997))
* **release:** 1.2.3 🚀 ([cd113e9](https://github.com/programinglive/dev-workflow-mcp-server/commit/cd113e9a2ca7a8a374f2ec07aa4a25f1c0570051))
* **release:** 1.2.4 🚀 ([7d39809](https://github.com/programinglive/dev-workflow-mcp-server/commit/7d398091359ee74c69f12e8fa77443615c32d51a))
* **release:** 1.2.5 🚀 ([e893f26](https://github.com/programinglive/dev-workflow-mcp-server/commit/e893f26a173306f96a40f68bf2c71706cc5fdb77))


### 📝 Documentation

* clarify user ID management ([a76381c](https://github.com/programinglive/dev-workflow-mcp-server/commit/a76381c842c1dea5e98116667addc4cbd0d022ed))

### [1.2.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.4...v1.2.5) (2025-11-03)

### [1.2.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.3...v1.2.4) (2025-11-03)

### [1.2.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.2...v1.2.3) (2025-11-03)

### [1.2.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.1...v1.2.2) (2025-11-03)

### [1.2.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.2.0...v1.2.1) (2025-11-03)

## [1.2.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.18...v1.2.0) (2025-11-03)


### 🐛 Bug Fixes

* reload workflow state from disk on each request to prevent stale state ([96bf50d](https://github.com/programinglive/dev-workflow-mcp-server/commit/96bf50de532713c2a83a3774d8e0dc05870eb24d))

### [1.1.18](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.17...v1.1.18) (2025-11-03)


### ✨ Features

* auto-detect primary branch for commit_and_push ([a68d38b](https://github.com/programinglive/dev-workflow-mcp-server/commit/a68d38ba547e6007bd2c0cfe5d231ebf417a2010))

### [1.1.17](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.16...v1.1.17) (2025-10-31)

### [1.1.16](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.15...v1.1.16) (2025-10-31)


### 🧹 Chores

* align npm provenance metadata ([459572e](https://github.com/programinglive/dev-workflow-mcp-server/commit/459572e07efa340ef87cc679535fb24413d8c997))

### [1.1.15](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.14...v1.1.15) (2025-10-31)


### 📝 Documentation

* add npm publish workflow automation ([c923734](https://github.com/programinglive/dev-workflow-mcp-server/commit/c923734ab4399afbcb0166abcd16cd01c3e50c0e))


### 👷 Continuous Integration

* **npm:** build + provenance in npm-publish workflow ([5ae04db](https://github.com/programinglive/dev-workflow-mcp-server/commit/5ae04db33e33fe64c33d8eac08db70e98754ea64))

### [1.1.14](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.13...v1.1.14) (2025-10-31)


### 🐛 Bug Fixes

* improve workflow state project root resolution ([a575e24](https://github.com/programinglive/dev-workflow-mcp-server/commit/a575e2404d26e550c8e52e4a524a75a3fa64752d))

### [1.1.13](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.12...v1.1.13) (2025-10-30)

### [1.1.12](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.11...v1.1.12) (2025-10-30)


### ✨ Features

* **cli:** add 'call' subcommand to invoke MCP tools directly (e.g., node index.js call drop_task) ([c9b8fae](https://github.com/programinglive/dev-workflow-mcp-server/commit/c9b8fae7e24e0915d857135d03fa969b10dcac67))
* **web:** docs modal, docs API, navbar redesign ([902242b](https://github.com/programinglive/dev-workflow-mcp-server/commit/902242b1318b01f8f62ef7c4c0f6347cb8517617))
* **web:** embed docs modal and redesign dashboard ([d2cf2fb](https://github.com/programinglive/dev-workflow-mcp-server/commit/d2cf2fb4ae90e61b20c72ed26f25dc0e5119247a))

### [1.1.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.10...v1.1.11) (2025-10-30)


### 🧹 Chores

* verify run_full_workflow with persisted project summary ([6fdb475](https://github.com/programinglive/dev-workflow-mcp-server/commit/6fdb475f65ee6ef2c061b0b1cf954a282406e2a1))


### ✨ Features

* add per-user state, SQLite project summary, and dashboard ([7b57b6e](https://github.com/programinglive/dev-workflow-mcp-server/commit/7b57b6e067ad59f2999a2badcb51b1293192c96b))
* per-project workflow state with unique per-user IDs; smarter workflow ([b710a52](https://github.com/programinglive/dev-workflow-mcp-server/commit/b710a524997583f58cd6da2567ba9fd14abdd3c9))

### [1.1.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.9...v1.1.10) (2025-10-29)


### ✨ Features

* add project knowledge library with persisted summary file for future database integration ([b9dc13f](https://github.com/programinglive/dev-workflow-mcp-server/commit/b9dc13f4b25dec756088a55185ccbfdb3988a644))

### [1.1.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.8...v1.1.9) (2025-10-29)


### 🧹 Chores

* interim commit ([b1aead0](https://github.com/programinglive/dev-workflow-mcp-server/commit/b1aead05920c766a183988fb93d3f0edc3e1eafc))


### ✅ Tests

* update README.md, exec.js, package-lock.json +7 more ([894fdf1](https://github.com/programinglive/dev-workflow-mcp-server/commit/894fdf1eace33ddf0081c565028d214e1c7697bf))


### ✨ Features

* make run_full_workflow smart and resumable from current phase ([930eb3c](https://github.com/programinglive/dev-workflow-mcp-server/commit/930eb3cb84c241b14f0e194cf490313e1e99a7ce))

### [1.1.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.7...v1.1.8) (2025-10-27)


### 📝 Documentation

* note DEV_WORKFLOW_STATE_FILE override ([bbeb11b](https://github.com/programinglive/dev-workflow-mcp-server/commit/bbeb11bc7f8be33f7c1a51b336283a3b2a48d3ea))

### [1.1.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.6...v1.1.7) (2025-10-26)


### ✨ Features

* prompt for documentation after tests pass ([a87e44f](https://github.com/programinglive/dev-workflow-mcp-server/commit/a87e44f2a78ea4c9220d62868ee1f9c7ad3b149b))

### [1.1.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.5...v1.1.6) (2025-10-26)


### 🐛 Bug Fixes

* avoid root workflow state path ([a9bd01b](https://github.com/programinglive/dev-workflow-mcp-server/commit/a9bd01bac6b0a17307385688a51873668498e0a0))
* require explicit commit before release ([5f58ead](https://github.com/programinglive/dev-workflow-mcp-server/commit/5f58ead9006595b7e57460fef585e3f9ea9de409))

### [1.1.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.4...v1.1.5) (2025-10-25)


### ✨ Features

* enforce release guard and per-project workflow state ([1c845a1](https://github.com/programinglive/dev-workflow-mcp-server/commit/1c845a1eb164863ab0269510b142e28ed1ea2136))

### [1.1.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.3...v1.1.4) (2025-10-25)


### 🐛 Bug Fixes

* ensure install script uses project root for workflow state ([8b8b32f](https://github.com/programinglive/dev-workflow-mcp-server/commit/8b8b32f5c436b256ec1edb05a406405a5c2455c1))

### [1.1.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.2...v1.1.3) (2025-10-25)


### ✨ Features

* make dev-workflow MCP installable with per-project workflow state isolation ([50e9ead](https://github.com/programinglive/dev-workflow-mcp-server/commit/50e9ead788f2bba1b0ff1a62515f3bcc78d0c8e6))

### [1.1.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.1...v1.1.2) (2025-10-25)

### [1.1.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.1.0...v1.1.1) (2025-10-25)


### ✨ Features

* add force_complete_task tool ([f731a7d](https://github.com/programinglive/dev-workflow-mcp-server/commit/f731a7d2e48295963b8573d4a2abd3ebd42ba5ab))

## [1.1.0](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.11...v1.1.0) (2025-10-25)


### 📝 Documentation

* clarify commit and push step ([c741f61](https://github.com/programinglive/dev-workflow-mcp-server/commit/c741f618813479c5df2bcca94c3dffc8881e97c8))


### 🐛 Bug Fixes

* allow commit_and_push on clean tree ([a831974](https://github.com/programinglive/dev-workflow-mcp-server/commit/a831974f66313ebe8752d416752076df63902bea))
* auto-detect commit in perform_release when tree is clean ([0db7038](https://github.com/programinglive/dev-workflow-mcp-server/commit/0db7038148f68963f53e52a5f73623dea7ad3462))


### ✨ Features

* check staged changes when resetting workflow to commit phase ([05d02fd](https://github.com/programinglive/dev-workflow-mcp-server/commit/05d02fd7ec6177af3fb1fd86ec093e1e37b56cbd))
* continue_workflow auto-executes next step in commit phase ([a5b49ed](https://github.com/programinglive/dev-workflow-mcp-server/commit/a5b49edaae7cb51ea3aa49d9b1b64587843441ce))

### [1.0.11](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.10...v1.0.11) (2025-10-25)


### ✨ Features

* add continue workflow guidance ([516b33e](https://github.com/programinglive/dev-workflow-mcp-server/commit/516b33ecfc7533df5868c9c26458088d6ea591a2))


### 🐛 Bug Fixes

* ensure commit and push happens before release ([08ee662](https://github.com/programinglive/dev-workflow-mcp-server/commit/08ee662f525431ba4a2d735ed253aad8d6720ac2))

### [1.0.10](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.9...v1.0.10) (2025-10-24)


### ♻️ Refactors

* modularize workflow server ([f0c9401](https://github.com/programinglive/dev-workflow-mcp-server/commit/f0c940123a8e6f961555cc7ba4d6dec2deb854e7))


### ✅ Tests

* cover release push flow ([933ff11](https://github.com/programinglive/dev-workflow-mcp-server/commit/933ff1126af08a49d1ce38a4eedcc738b0064efb))

### [1.0.9](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.8...v1.0.9) (2025-10-23)


### 📝 Documentation

* explain local workflow state ([cb6e333](https://github.com/programinglive/dev-workflow-mcp-server/commit/cb6e33353b4e1c0f693146f6cb07c9437a7f5aa8))

### [1.0.8](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.7...v1.0.8) (2025-10-21)


### ✨ Features

* allow skipping tests and dropping workflow tasks ([2b8b27c](https://github.com/programinglive/dev-workflow-mcp-server/commit/2b8b27cca611d2fe266c1b814c21b6fec2472856))

### [1.0.7](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.6...v1.0.7) (2025-10-20)

### [1.0.6](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.5...v1.0.6) (2025-10-20)


### ✅ Tests

* enforce clean release workflow ([c261a7b](https://github.com/programinglive/dev-workflow-mcp-server/commit/c261a7b3d141ba4472567bd47e4f6b6e4d2ee3fd))

### [1.0.5](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.4...v1.0.5) (2025-10-20)


### ✅ Tests

* update index.js and tests/workflowState.test.js ([b9df3c8](https://github.com/programinglive/dev-workflow-mcp-server/commit/b9df3c8643303769dbe4c5a0992995b6328cdfcf))

### [1.0.4](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.3...v1.0.4) (2025-10-20)


### ✨ Features

* enforce release step after ready check ([0725496](https://github.com/programinglive/dev-workflow-mcp-server/commit/07254967becd515cb2a4261d62af01dfeb842175))


### 🐛 Bug Fixes

* support windows-friendly commit quoting ([47881fd](https://github.com/programinglive/dev-workflow-mcp-server/commit/47881fd0db54da3fabe368b1a135902e47ef873e))

### [1.0.3](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.2...v1.0.3) (2025-10-20)


### 🧹 Chores

* add gitignore ([5f695fb](https://github.com/programinglive/dev-workflow-mcp-server/commit/5f695fbc71515c7f1ffbc44fd74b52314c966ee6))


### 📝 Documentation

* clarify cross-platform installation ([52b5ee7](https://github.com/programinglive/dev-workflow-mcp-server/commit/52b5ee7061e8f968ff94e6c226586fc1b7e2a057))

### [1.0.2](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.1...v1.0.2) (2025-10-19)


### 🐛 Bug Fixes

* guard run_tests arguments ([2004c59](https://github.com/programinglive/dev-workflow-mcp-server/commit/2004c590fabe359d068122cf240a731382f81ca0))
* normalize tool call arguments ([44d5a3d](https://github.com/programinglive/dev-workflow-mcp-server/commit/44d5a3d35f191012445fa02cee6254afbc993c98))


### 📝 Documentation

* clarify tool argument requirements ([4528614](https://github.com/programinglive/dev-workflow-mcp-server/commit/45286146661ad850eccb04849c11819e91ddd580))

### [1.0.1](https://github.com/programinglive/dev-workflow-mcp-server/compare/v1.0.0...v1.0.1) (2025-10-18)


### 🧹 Chores

* configure release tooling ([772fc64](https://github.com/programinglive/dev-workflow-mcp-server/commit/772fc6400fb7d2d481992f6f03f25c094cb3924c))

## 1.0.0 (2025-10-18)


### ✨ Features

* initial release ([9bd5835](https://github.com/programinglive/dev-workflow-mcp-server/commit/9bd5835af92776d9247efa50238ac5d71b00b492))


### 📝 Documentation

* add governance and contribution guidelines ([cfa78ea](https://github.com/programinglive/dev-workflow-mcp-server/commit/cfa78ea592788257f703d84974d78145a5312ca4))


### 🧹 Chores

* ensure clean staging before completing tasks ([7186629](https://github.com/programinglive/dev-workflow-mcp-server/commit/7186629fc2415b2d279a8a8d3451f52839dd2d28))
* revert @modelcontextprotocol/sdk to ^1.0.0 ([305d71f](https://github.com/programinglive/dev-workflow-mcp-server/commit/305d71f330027d8466828af53c939b4491cccee9))
* scope package under programinglive ([7388773](https://github.com/programinglive/dev-workflow-mcp-server/commit/7388773a50f0e06450558115edb367749245c31b))

## 1.0.0 (2025-10-18)


### ✨ Features

* initial release ([9bd5835](https://github.com/programinglive/dev-workflow-mcp-server/commit/9bd5835af92776d9247efa50238ac5d71b00b492))


### 📝 Documentation

* add governance and contribution guidelines ([cfa78ea](https://github.com/programinglive/dev-workflow-mcp-server/commit/cfa78ea592788257f703d84974d78145a5312ca4))


### 🧹 Chores

* ensure clean staging before completing tasks ([7186629](https://github.com/programinglive/dev-workflow-mcp-server/commit/7186629fc2415b2d279a8a8d3451f52839dd2d28))
* revert @modelcontextprotocol/sdk to ^1.0.0 ([305d71f](https://github.com/programinglive/dev-workflow-mcp-server/commit/305d71f330027d8466828af53c939b4491cccee9))
* scope package under programinglive ([7388773](https://github.com/programinglive/dev-workflow-mcp-server/commit/7388773a50f0e06450558115edb367749245c31b))
