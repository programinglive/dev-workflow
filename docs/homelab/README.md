# Homelab Development Guide

Panduan konfigurasi homelab development untuk **programinglive** tailnet. Dokumen ini menjadi referensi standar saat setup mesin baru atau troubleshooting koneksi antar-node.

---

## Topologi

```
MMCH (Windows 11) ─── Tailscale ─── HELLOWORLD (Windows)
                            │
                            └── Tailscale ─── Mac (macOS)
```

Semua komunikasi SSH dan layanan internal berjalan di atas Tailscale tailnet `tail34fbfd.ts.net`. Port 22 tidak pernah terbuka ke LAN atau internet.

---

## Perangkat

| Hostname | Tailscale IP | OS | Role |
|---|---|---|---|
| `mmch` | `100.109.164.16` | Windows 11 Pro (build 26200) | Primary dev machine |
| `helloworld` | `100.90.209.77` | Windows | Secondary dev machine |
| `mahatmas-macbook-pro` | `100.127.94.70` | macOS | macOS dev machine |

---

## Repositori Terkait

| Repo | Visibility | Deskripsi |
|---|---|---|
| `mmch` | Private | Konfigurasi utama MMCH + infrastruktur |
| `helloworld` | Private | Konfigurasi HELLOWORLD |
| `mac-optimization` | Private | Konfigurasi Mac |
| `dev-workflow-mcp-server` | Private | MCP server workflow discipline |

---

## Quick Reference

- **SSH dari MMCH**: `ssh helloworld`, `ssh mac`
- **SSH dari HELLOWORLD/Mac ke MMCH**: `ssh mmch`
- **Tailscale IP range**: `100.64.0.0/10`
- **SSH user**: `mahardhika` (admin di semua machine)
- **Cross-machine key**: `~/.ssh/id_ed25519_devgroup`
- **GitLab key**: `~/.ssh/id_ed25519` (jangan ditimpa)

---

## Dokumentasi Lengkap

- [Tailnet & SSH Infrastructure](./infra-tailnet-ssh.md)
- [CLI Tools Per Machine](./cli-tools.md)
- [Self-Hosted CI Runner](./ci-runner.md)
- [Security Rules](./security-rules.md)

---

## Workflow Dev dengan MCP

Untuk memulai task development di project manapun, gunakan MCP tools:

```
1. start_task → 2. Implement → 3. mark_bug_fixed
→ 4. create_tests → 5. run_tests → 6. create_documentation
→ 7. check_ready_to_commit → 8. commit_and_push
→ 9. perform_release → 10. complete_task
```

Lihat `.agent/workflows/` untuk template workflow lengkap.
