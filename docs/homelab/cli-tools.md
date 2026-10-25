# CLI Tools Per Machine

CLI tools installed on each homelab machine.

---

## MMCH (Windows 11 Pro)

| Tool | Version | Auth / Status |
|---|---|---|
| `gh` | 2.102.0 | Logged in as `mahatmamahardhikach` |
| `glab` | 1.124.0 | Installed; token not configured for profile `mahardhika` |
| `wrangler` | 4.151.3 | Logged in via Cloudflare OAuth |
| `node` | 24.20.0 | Installed |
| `npm` | 11.19.0 | Installed |
| `opencode` | 1.19.1 | Installed |
| `codex` | 0.163.0 | Installed via npm |
| `cloudflared` | — | Not installed |

The GitHub Actions runner (`mmch-dev-workflow`) also lives here, in
`C:\actions-runner`. See [ci-runner.md](./ci-runner.md).

### GitLab profiles

- Profile `mahardhika`: token not configured
- Profile `DHIKA`: separate login as user `moszes`

---

## HELLOWORLD (Windows)

| Tool | Version / Status |
|---|---|
| Tailscale | Online |
| OpenSSH Server | Running |
| SSH user | `mahardhika` |
| `node` | 24.12.0 |
| `npm` | 11.19.0 |
| `gh` | 2.102.0 |
| `opencode` | 2.0.32 |
| `git` | 2.51.0.windows.2 |
| `pwsh` | 7.6.6 (PowerShell 7 installed) |

Other tools are installed per project.

---

## Mac (macOS)

| Detail | Value |
|---|---|
| Hostname | `mahatmas-macbook-pro` |
| Tailscale IP | `100.127.94.70` |
| SSH user | `mahardhika` (verify on macOS) |
| Related repo | `mac-optimization` |

---

## Common environment variables

Some tools need the following environment variables. Keep them in `.env` or your
shell profile — **never commit them**.

```bash
# GitHub
GH_TOKEN=<github-personal-access-token>

# GitLab
GL_TOKEN=<gitlab-private-token>

# Cloudflare
CF_ACCOUNT_ID=15d29c8639fd3733b1b5486a2acfd968
CF_API_TOKEN=<cloudflare-api-token>

# Tailscale (optional, for auth)
TAILSCALE_AUTH_KEY=<tailscale-auth-key>
```

For the OpenCode MCP server, add this to the config if you need per-client state
isolation:

```bash
DEV_WORKFLOW_USER_ID=<your-identity>
```

---

## Security notes

- Private tokens and keys are **never** committed to the repository
- `.env` and `.env.*` are covered by `.gitignore`, **except `.env.production`**
  and `.env.example`, which are explicitly un-ignored (`!.env.production`,
  `!.env.example`) and therefore tracked
- `.env.production` currently contains only placeholders, not real credentials.
  If it ever gains a real value, remove the `!.env.production` exception first
- For CI/CD, use GitHub/GitLab secrets or runner environment variables
