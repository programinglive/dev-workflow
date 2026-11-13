# Distribution & Supply-Chain Security Policy

**Document Version:** 1.0.0  
**Target:** NPM Distribution & GitHub Releases  

---

## 1. Package Content Whitelisting

To prevent accidental inclusion of development state, internal documents, or local test fixtures in distributed npm packages or tarballs, `package.json` must enforce an explicit `files` whitelist:

```json
{
  "files": [
    "index.js",
    "bin/",
    "cli/",
    "contracts/",
    "policy/",
    "evidence/",
    "db/",
    "tools/",
    "security/",
    "monitor-server/",
    "workflow-state.js",
    "workflow-guidance.js",
    "mcp-index.js",
    "build-monitor.js",
    "git-facade.js",
    "git-helpers.js",
    "commit-helpers.js",
    "exec.js",
    "utils.js",
    "LICENSE",
    "README.md",
    "package.json"
  ]
}
```

### Mandatory Exclusions (via `.npmignore` / `files`):
- `.state/` (local SQLite databases, locks, and history)
- `.worktrees/` (isolated agent checkouts)
- `tests/` and test fixtures
- `managed/` (internal private fleet rollout scripts)
- `docs/homelab/` (internal server architecture docs)
- `.env*` (local environment configurations)

---

## 2. Supply-Chain & Build Verification

1. **Reproducible Builds:** The package must be buildable via `npm ci` and `npm test` on any clean Node.js >=20 environment without network access.
2. **Provenance & Attestation:** Future npm publishes will use GitHub Actions OIDC trusted publishing with signed provenance (`npm publish --provenance`).
3. **No Privileged Lifecycle Scripts:** `package.json` must not execute arbitrary binaries or download remote assets during `preinstall` or `postinstall`.
