# Tailnet & SSH Infrastructure

Panduan lengkap konfigurasi Tailscale dan SSH aman antar mesin homelab.

---

## 1. Tailnet

- **Akun Tailscale**: `programinglive`
- **MagicDNS suffix**: `tail34fbfd.ts.net`
- **MagicDNS**: enabled tailnet-wide
- **CGNAT IPv4 range**: `100.64.0.0/10`

### Perangkat Terdaftar

| Hostname | Tailscale IP | OS |
|---|---|---|
| `mmch` | `100.109.164.16` | Windows 11 Pro |
| `helloworld` | `100.90.209.77` | Windows |
| `mahatmas-macbook-pro` | `100.127.94.70` | macOS |

**Aturan firewall**: SSH ingress hanya diizinkan dari `100.64.0.0/10`. Tidak ada rule TCP 22 yang membuka ke LAN atau internet.

---

## 2. MMCH — Windows 11 Pro

### OpenSSH Server

- Versi: **Win32-OpenSSH 10.4p1** (MSI resmi, bukan Windows optional capability)
- Service `sshd`: `Automatic`, `Running`
- Listening: TCP 22 (IPv4 + IPv6)
- Built-in `Administrator` account tetap disabled

### Hardening `sshd_config`

```
DenyUsers Administrator
Match Group administrators
    AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
```

### Authorized Keys (administrator)

Karena `mahardhika` adalah member `Administrators`, public key diletakkan di:
```
C:\ProgramData\ssh\administrators_authorized_keys
```

ACL wajib:
- Owner: `BUILTIN\Administrators`
- Hanya `NT AUTHORITY\SYSTEM` dan `BUILTIN\Administrators` yang punya Full Control
- Inheritance disabled

```powershell
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F"
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /setowner "*S-1-5-32-544"
```

Untuk non-admin user, gunakan `%USERPROFILE%\.ssh\authorized_keys` biasa.

### Firewall Rules

```
MMCH SSH (Tailscale only)  → 100.64.0.0/10
OpenSSH SSH Server Preview  → 100.64.0.0/10
```

Tidak ada rule inbound TCP 22 yang mengizinkan `LAN` atau `Any`.

### SSH Client Config

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

> **Penting**: `StrictHostKeyChecking ask` tetap aktif. Jangan diset ke `no`.

### Keys

| Key |用途 |
|---|---|
| `~/.ssh/id_ed25519` | GitLab (retain, jangan ditimpa) |
| `~/.ssh/id_ed25519_devgroup` | Cross-machine SSH (preferred) |

**Public key** untuk disebar ke HELLOWORLD dan Mac:
```
ssh-ed25519 <redacted-public-key> devgroup@MMCH
```
Fingerprint: `SHA256:J0+58fUdrXHNyd5upO7HkSx0+sANnYe88UNjbCasnIw`

---

## 3. HELLOWORLD — Windows

- Tailscale: online, `100.90.209.77`
- MagicDNS: `helloworld.tail34fbfd.ts.net`
- SSH user: `mahardhika`

### Checklist Setup

1. Install OpenSSH Server (Windows optional capability atau MSI resmi)
2. Start service `sshd`, set ke `Automatic`
3. Tambahkan public key MMCH ke authorized keys
4. Apply ACL (jika user admin)
5. Tambahkan public key HELLOWORLD ke MMCH untuk reverse access
6. Test: `ssh helloworld hostname`

---

## 4. Mac — macOS

- Tailscale host: `mahatmas-macbook-pro` / `mahatmas-macbook-pro.tail34fbfd.ts.net`
- SSH user: `mahardhika` (konfirmasi username macOS)
- Repo terkait: `mac-optimization`

### Checklist Setup

1. Enable **Remote Login** (System Settings → General → Sharing → Remote Login)
2. Pastikan firewall macOS mengizinkan SSH di interface Tailscale
3. Tambahkan public key MMCH ke `~/.ssh/authorized_keys` dengan mode `600`
4. Tambahkan public key Mac ke MMCH `administrators_authorized_keys`
5. Test: `ssh mac hostname`

---

## 5. New Machine Onboarding Checklist

1. Join tailnet yang sama + enable MagicDNS
2. Install OpenSSH server
   - Windows: Windows capability (jika Windows Update jalan) atau MSI resmi Win32-OpenSSH
   - macOS: enable Remote Login
3. Set SSH service auto-start
4. Disable Administrator/root SSH login
5. Restrict inbound TCP 22 ke `100.64.0.0/10` only
6. Generate Ed25519 key lokal untuk mesin baru
7. Tukar public key saja — **private key tidak pernah离开 mesin asalnya**
8. Apply ACL Windows untuk administrator accounts
9. Tambahkan alias ke `~/.ssh/config`
10. Test kedua arah dengan `hostname` / `whoami`
11. Update dokumen ini

---

## 6. Troubleshooting

### SSH auth fails pada Windows

- Cek ACL: `icacls C:\ProgramData\ssh\administrators_authorized_keys`
- Harus ada hanya SYSTEM + Administrators
- Inheritance harus disabled
- Coba `Get-Service sshd | Restart-Service`

### MagicDNS tidak resolve

- Pastikan Tailscale versi terbaru
- Cek `tailscale status`
- Verify MagicDNS enabled di admin console tailnet

### Port 22 tidak reachable dari mesin lain

- Cek `Get-NetFirewallRule | Where-Object {$_.DisplayName -like '*SSH*'}`
- Pastikan rule enable dan scope hanya `100.64.0.0/10`
