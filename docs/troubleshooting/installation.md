# Troubleshooting Installation

## `devwf` or `dev-workflow-mcp` command not found
- Verify npm global bin directory is on your `PATH`:
  ```bash
  npm prefix -g
  ```
- Reinstall globally or run with `npx`:
  ```bash
  npm install -g @programinglive/dev-workflow
  ```

## `better-sqlite3` native build failure
- DevWorkflow requires Node.js `>=20.0.0`.
- If prebuilt binaries fail to download behind a corporate proxy, ensure Python 3 and C++ build tools are installed, or set `npm_config_build_from_source=false`.

## Diagnostic Verification
Always run `devwf doctor` (read-only) to inspect Node.js, Git, local SQLite storage, and optional integrations without exposing secrets.
