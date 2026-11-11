# Fleet MCP and CI runner parity audit

Date: **11 November 2026**.
Scope: HELLOWORLD, Mac, MMCH × OpenCode, Codex, AGY (Antigravity).

## Why this audit exists

The owner asked whether every device and every AI CLI carries the same tools.
The answer was no, and the differences were invisible because each CLI keeps its
own config file in its own format:

| CLI | Config file | Shape |
|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.servers` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.<name>]` |
| AGY | `~/.gemini/config/mcp_config.json` | `mcpServers` |

## Measured state

| Item | HELLOWORLD | Mac | MMCH | Verdict |
|---|---|---|---|---|
| ManagedMCP release | 1.29.4 / `e8eaee7` | 1.29.4 / `e8eaee7` | 1.29.4 / `e8eaee7` | same |
| OpenCode servers | 9 | 9 | 9 | same |
| Codex servers | 16 | 9 | 9 | differs |
| AGY servers | 14 | 9 | 0 | differs |
| GitLab runner | none | none | ERP `bw-server` + Clinic | differs |
| GitHub Actions runner | none | none | factory | differs |

The ManagedMCP release is genuinely uniform: `last-good.json` reports the same
`revision`, `sha256` and `version` on all three devices. The Mac stores it under
`~/.local/share/ProgramingLive/ManagedMCP`, not under `~/Library/Application
Support`, which is why an earlier check reported it as missing.

### Codex

HELLOWORLD carries seven servers the other two do not: `chrome-devtools`,
`cloudflare-2`, `cloudflare-bindings`, `cloudflare-builds`, `cloudflare-docs`,
`cloudflare-observability`, `programinglive`.

### AGY

HELLOWORLD carries `netlify`, `cloudflare-2`, the four `google-cloud-*` servers,
`notebooks` and `data-agent-kit`, but is missing `zettly`, `pocketbase` and
`central-gateway`. MMCH's `mcp_config.json` is a **0-byte file**, so AGY on MMCH
has no MCP servers at all. Backups exist next to it
(`mcp_config.json.bak-bwtools-20261107`, 2959 bytes).

### OpenCode

All three devices carry the same nine servers. `MCP-PARITY.md` declares a
ten-server baseline that includes `factory`, so the document and the devices
disagree. The document also still points `central-gateway` at
`http://100.78.134.44:3200/sse` while the devices use
`http://100.77.138.14:3200/mcp`.

## CI runner topology (verified)

| Runner | ID | Tag | Platform | Status |
|---|---|---|---|---|
| `MMCH ERP Runner` | 58764237 | `bw-server` | windows | online |
| `bw-tools clinic linux` | 58882401 | `bw-tools` | linux (Debian) | online |
| `bw-server-clean ERP runner` | 58346133 | `bw-server` | — | deleted 11 Nov 2026 |

`bw-tools` has no Docker (`docker: MISSING`), so the `frontend_erp` image build
(`docker:24.0.5` + `docker:24.0.5-dind`) cannot run there as written. The ERP
pipeline requires tag `bw-server`, which only the MMCH runner carries.

## Remediation

1. **AGY on MMCH** — restore `mcp_config.json` from
   `mcp_config.json.bak-bwtools-20261107`, then add `zettly`, `pocketbase` and
   `central-gateway` so it matches the Mac set. Do not copy tokens between
   devices; each device keeps its own.
2. **AGY on HELLOWORLD** — add `zettly`, `pocketbase`, `central-gateway`; decide
   whether the GCP/`netlify`/`notebooks` servers stay (they are not in the
   parity baseline).
3. **Codex on HELLOWORLD** — either drop the seven extra servers or add them to
   Mac and MMCH. Pick one direction and record it in `MCP-PARITY.md`.
4. **`MCP-PARITY.md`** — correct the `central-gateway` URL and reconcile the
   `factory` entry with what the devices actually load.
5. **Runner** — either keep ERP on MMCH and stop claiming it is decommissioned,
   or register a `bw-server` runner on `bw-tools` and install Docker there
   before moving `frontend_erp`.

## Verification commands

```sh
# OpenCode / Codex inventory on any device
node mcp-inventory.cjs <opencode.json> <codex config.toml>

# AGY inventory
node -e "console.log(Object.keys(require(process.env.HOME+'/.gemini/config/mcp_config.json').mcpServers))"

# ManagedMCP release
cat ~/.local/share/ProgramingLive/ManagedMCP/last-good.json

# Runner inventory
glab api "projects/beautyworld_repository%2Ferp.beautyworld.co.id/runners?per_page=100"
```
