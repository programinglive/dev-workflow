# CLI Tools Per Machine

Daftar tool CLI yang terinstall di setiap mesin homelab.

---

## MMCH (Windows 11 Pro)

| Tool | Version | Auth / Status |
|---|---|---|
| `gh` | 2.102.0 | Logged in as `mahatmamahardhikach` |
| `glab` | 1.124.0 | Installed; token belum di-profile `mahardhika` |
| `wrangler` | 4.151.3 | Logged in via Cloudflare OAuth |
| `node` | 24.20.0 | Installed |
| `npm` | 11.19.0 | Installed |
| `opencode` | 1.19.1 | Installed |
| `codex` | 0.163.0 | Installed via npm |
| `cloudflared` | — | Not installed |

### Profile GitLab

- Profile `mahardhika`: token belum dikonfigurasi
- Profile `DHIKA`: login terpisah dengan user `moszes`

---

## HELLOWORLD (Windows)

| Tool | Status |
|---|---|
| Tailscale | Online |
| OpenSSH Server | Running |
| SSH user | `mahardhika` |

Tool lain sesuai kebutuhan project.

---

## Mac (macOS)

| Detail | Value |
|---|---|
| Hostname | `mahatmas-macbook-pro` |
| Tailscale IP | `100.127.94.70` |
| SSH user | `mahardhika` (verifikasi di macOS) |
| Repo terkait | `mac-optimization` |

---

## Environment Variables Umum

Beberapa tool membutuhkan env var berikut (simpan di `.env` atau shell profile, **jangan commit**):

```bash
# GitHub
GH_TOKEN=<github-personal-access-token>

# GitLab
GL_TOKEN=<gitlab-private-token>

# Cloudflare
CF_ACCOUNT_ID=15d29c8639fd3733b1b5486a2acfd968
CF_API_TOKEN=<cloudflare-api-token>

# Tailscale (opsional, untuk auth)
TAILSCALE_AUTH_KEY=<tailscale-auth-key>
```

Untuk opencode MCP server, tambahkan ke config jika diperlukan:

```bash
DEV_WORKFLOW_USER_ID=<your-identity>
```

---

## Catatan Keamanan

- Private tokens dan keys **tidak pernah** di-commit ke repository
- `.env` dan `.env.*` sudah ada di `.gitignore`
- Untuk CI/CD, gunakan GitHub/GitLab secrets atau runner environment variables
- Cloudflare tokens disimpan di `.env.production` (juga di-gitignore)
