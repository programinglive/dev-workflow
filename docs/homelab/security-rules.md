# Security Rules

Security rules that apply across the entire **programinglive** homelab.

---

## 1. Keys and credentials

- Private keys and tokens stay on the machine that created them
- Public keys may be distributed and registered on other machines
- GitHub, GitLab, Cloudflare and Tailscale tokens are **never** hardcoded in code
- Use `.env`, GitHub secrets, or environment variables

---

## 2. SSH

- **Do not** open port 22 on the router or to the public internet
- SSH ingress only from the Tailscale CGNAT range `100.64.0.0/10`
- **Do not** disable host key verification (`StrictHostKeyChecking ask` stays on)
- **Do not** enable the built-in Administrator/root account for SSH
- Private keys are never copied between machines

---

## 3. Repositories

- Homelab-related repos (`mmch`, `helloworld`, `mac-optimization`) are **private**
- After committing, check `git log` and `git diff --cached` to confirm no
  credential slipped in
- `.env`, `.env.*`, `node_modules/` and `.state/` are gitignored, with two
  deliberate exceptions: `.env.example` and `.env.production` are un-ignored and
  tracked. `.env.production` holds placeholders only; if a real value is ever
  added, remove the `!.env.production` exception first

---

## 4. Firewall

| Machine | Rule |
|---|---|
| MMCH | TCP 22 only from `100.64.0.0/10` |
| HELLOWORLD | TCP 22 only from `100.64.0.0/10` |
| Mac | SSH over the Tailscale interface; macOS firewall allow |

No router port forwarding for internal services.

---

## 5. Tailscale

- MagicDNS enabled tailnet-wide
- Use MagicDNS hostnames (`helloworld.tail34fbfd.ts.net`) rather than static IPs
- Access control: do not share long-lived auth keys unless required
- Consider enabling Tailnet Lock to enforce device compliance (optional)

---

## 6. Pre-commit checklist

Use the `pre_commit_checklist` prompt from the dev-workflow MCP server, or check
manually:

- [ ] No token or key in the diff
- [ ] No `.env` file committed
- [ ] Distributed public keys are public only (never private)
- [ ] SSH config contains no sensitive private key paths

---

## 7. Incident response

If a credential is stolen or leaked:

1. **Rotate** — generate a new key or token
2. **Revoke** the old one in its panel (GitHub, GitLab, Cloudflare, Tailscale)
3. **Audit** — check access logs and any commit that may be affected
4. **Update** — replace it on every machine that used it
5. **Document** — record the change in `docs/homelab/` if it alters the security
   configuration
