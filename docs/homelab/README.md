# Homelab Development Guide

Configuration guide for the **programinglive** homelab tailnet. This is the
standard reference when setting up a new machine or troubleshooting
node-to-node connectivity.

---

## Topology

```
MMCH (Windows 11) ─── Tailscale ─── HELLOWORLD (Windows)
                            │
                            └── Tailscale ─── Mac (macOS)
```

All SSH traffic and internal services run over the Tailscale tailnet
`tail34fbfd.ts.net`. Port 22 is never exposed to the LAN or the internet.

---

## Machines

| Hostname | Tailscale IP | OS | Role |
|---|---|---|---|
| `mmch` | `100.109.164.16` | Windows 11 Pro (build 26200) | Primary dev machine |
| `helloworld` | `100.90.209.77` | Windows | Secondary dev machine |
| `mahatmas-macbook-pro` | `100.127.94.70` | macOS | macOS dev machine |

---

## Related repositories

| Repo | Visibility | Description |
|---|---|---|
| `mmch` | Private | Primary MMCH configuration and infrastructure |
| `helloworld` | Private | HELLOWORLD configuration |
| `mac-optimization` | Private | Mac configuration |
| `dev-workflow-mcp-server` | Private | MCP server for workflow discipline |

---

## Quick reference

- **SSH from MMCH**: `ssh helloworld`, `ssh mac`
- **SSH from HELLOWORLD/Mac to MMCH**: `ssh mmch`
- **Tailscale IP range**: `100.64.0.0/10`
- **SSH user**: `mahardhika` (admin on every machine)
- **Cross-machine key**: `~/.ssh/id_ed25519_devgroup`
- **GitLab key**: `~/.ssh/id_ed25519` (do not overwrite)

---

## Full documentation

- [Tailnet & SSH Infrastructure](./infra-tailnet-ssh.md)
- [CLI Tools Per Machine](./cli-tools.md)
- [Self-Hosted CI Runner](./ci-runner.md)
- [Security Rules](./security-rules.md)

---

## Development workflow with MCP

To start a development task in any project, use the MCP tools:

```
1. start_task → 2. Implement → 3. mark_bug_fixed
→ 4. create_tests → 5. run_tests → 6. create_documentation
→ 7. check_ready_to_commit → 8. commit_and_push
→ 9. perform_release → 10. complete_task
```

See `.agent/workflows/` for complete workflow templates.
