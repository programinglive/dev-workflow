# Tailnet & SSH Infrastructure

Complete guide to Tailscale and secure SSH configuration across homelab machines.

---

## 1. Tailnet

- **Tailscale account**: `programinglive`
- **MagicDNS suffix**: `tail34fbfd.ts.net`
- **MagicDNS**: enabled tailnet-wide
- **CGNAT IPv4 range**: `100.64.0.0/10`

### Registered devices

| Hostname | Tailscale IP | OS |
|---|---|---|
| `mmch` | `100.109.164.16` | Windows 11 Pro |
| `helloworld` | `100.90.209.77` | Windows |
| `mahatmas-macbook-pro` | `100.127.94.70` | macOS |

**Firewall rule**: SSH ingress is allowed only from `100.64.0.0/10`. No TCP 22
rule opens to the LAN or the internet.

---

## 2. MMCH — Windows 11 Pro

### OpenSSH Server

- Version: **Win32-OpenSSH 10.4p1** (official MSI, not the Windows optional capability)
- `sshd` service: `Automatic`, `Running`
- Listening: TCP 22 (IPv4 + IPv6)
- The built-in `Administrator` account stays disabled

### `sshd_config` hardening

```
DenyUsers Administrator
Match Group administrators
    AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
```

### Authorized keys (administrator)

Because `mahardhika` is a member of `Administrators`, the public key goes in:

```
C:\ProgramData\ssh\administrators_authorized_keys
```

ACL requirements:

- Owner: `BUILTIN\Administrators`
- Only `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators` have Full Control
- Inheritance disabled

```powershell
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F"
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /setowner "*S-1-5-32-544"
```

For a non-admin user, use the normal `%USERPROFILE%\.ssh\authorized_keys`.

### Firewall rules

```
MMCH SSH (Tailscale only)  → 100.64.0.0/10
OpenSSH SSH Server Preview  → 100.64.0.0/10
```

No inbound TCP 22 rule allows `LAN` or `Any`.

### SSH client config

File: `C:\Users\mahardhika\.ssh\config`

```ssh
Host helloworld
    HostName helloworld.tail34fbfd.ts.net
    User mahardhika
    Port 22
    IdentitiesOnly yes
    IdentityFile ~/.ssh/id_ed25519_devgroup
    IdentityFile ~/.ssh/id_ed25519

Host mac
    HostName mahatmas-macbook-pro.tail34fbfd.ts.net
    User mahardhika
    Port 22
    IdentitiesOnly yes
    IdentityFile ~/.ssh/id_ed25519_devgroup
    IdentityFile ~/.ssh/id_ed25519
```

> **Important**: keep `StrictHostKeyChecking ask`. Never set it to `no`.

### Keys

| Key | Purpose |
|---|---|
| `~/.ssh/id_ed25519` | GitLab (keep it, never overwrite) |
| `~/.ssh/id_ed25519_devgroup` | Cross-machine SSH (preferred) |

**Public key** to distribute to HELLOWORLD and Mac:

```
ssh-ed25519 <redacted-public-key> devgroup@MMCH
```

Fingerprint: `SHA256:J0+58fUdrXHNyd5upO7HkSx0+sANnYe88UNjbCasnIw`

---

## 3. HELLOWORLD — Windows

- Tailscale: online, `100.90.209.77`
- MagicDNS: `helloworld.tail34fbfd.ts.net`
- SSH user: `mahardhika`

### Setup checklist

1. Install OpenSSH Server (Windows optional capability or the official MSI)
2. Start the `sshd` service and set it to `Automatic`
3. Add MMCH's public key to the authorized keys
4. Apply the ACL if the user is an administrator
5. Add HELLOWORLD's public key to MMCH for reverse access
6. Test: `ssh helloworld hostname`

---

## 4. Mac — macOS

- Tailscale host: `mahatmas-macbook-pro` / `mahatmas-macbook-pro.tail34fbfd.ts.net`
- SSH user: `mahardhika` (confirm the macOS username)
- Related repo: `mac-optimization`

### Setup checklist

1. Enable **Remote Login** (System Settings → General → Sharing → Remote Login)
2. Make sure the macOS firewall allows SSH on the Tailscale interface
3. Add MMCH's public key to `~/.ssh/authorized_keys` with mode `600`
4. Add Mac's public key to MMCH's `administrators_authorized_keys`
5. Test: `ssh mac hostname`

---

## 5. New machine onboarding checklist

1. Join the same tailnet and enable MagicDNS
2. Install an OpenSSH server
   - Windows: Windows capability (if Windows Update works) or the official Win32-OpenSSH MSI
   - macOS: enable Remote Login
3. Set the SSH service to start automatically
4. Disable Administrator/root SSH login
5. Restrict inbound TCP 22 to `100.64.0.0/10` only
6. Generate a local Ed25519 key for the new machine
7. Exchange **public keys only** — a private key never leaves the machine that created it
8. Apply Windows ACLs for administrator accounts
9. Add an alias to `~/.ssh/config`
10. Test both directions with `hostname` / `whoami`
11. Update this document

---

## 6. Troubleshooting

### SSH auth fails on Windows

- Check the ACL: `icacls C:\ProgramData\ssh\administrators_authorized_keys`
- It must contain only SYSTEM and Administrators
- Inheritance must be disabled
- Try `Get-Service sshd | Restart-Service`

### MagicDNS does not resolve

- Make sure Tailscale is current
- Check `tailscale status`
- Verify MagicDNS is enabled in the tailnet admin console

### Port 22 is not reachable from another machine

- Check `Get-NetFirewallRule | Where-Object {$_.DisplayName -like '*SSH*'}`
- Make sure the rule is enabled and scoped to `100.64.0.0/10` only
