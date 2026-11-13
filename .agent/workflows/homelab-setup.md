---
description: Homelab infrastructure setup and maintenance workflow
---

# Homelab Infrastructure Workflow

Workflow untuk setup atau maintain infrastruktur homelab (Tailscale + SSH antar mesin).

---

## When to Use

- Menambahkan mesin baru ke tailnet
- Troubleshooting koneksi SSH antar node
- Rotasi kunci SSH
- Update konfigurasi firewall

---

## Prerequisites

Pastikan sebelum memulai:

1. Tailscale terinstall di semua mesin target
2. Semua mesin join tailnet yang sama (`programinglive`)
3. MagicDNS enabled

---

## Step 1: Start Task

```
Use start_task tool:
- description: "Setup SSH antar mesin homelab — <deskripsi tugas>"
- type: "feature"
```

---

## Step 2: Design Flow (Mermaid)

Deskripsikan alur setup dengan Mermaid:

```
Use create_feature_flow tool:
- mermaidCode: |
    graph TD
        A[Join Tailscale] --> B[Install OpenSSH]
        B --> C[Enable sshd Auto-Start]
        C --> D[Generate Ed25519 Key]
        D --> E[Share Public Key]
        E --> F[Test SSH Bidirectional]
- description: "Homelab SSH onboarding flow"
```

---

## Step 3: Implement

Lakukan konfigurasi sesuai playbook:

### Windows (MMCH / HELLOWORLD)

```powershell
# 1. Install OpenSSH (jika belum)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# 2. Start & auto-start sshd
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# 3. Hardening: deny root admin login
# Edit: C:\ProgramData\ssh\sshd_config
# Tambahkan: DenyUsers Administrator

# 4. Tambah public key ke administrators_authorized_keys
# 5. Apply ACL
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F"
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /setowner "*S-1-5-32-544"

# 6. Firewall rule (hanya Tailscale)
New-NetFirewallRule -DisplayName "MMCH SSH (Tailscale only)" -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress "100.64.0.0/10" -Action Allow
```

### macOS (Mac)

```bash
# 1. Enable Remote Login
sudo systemsetup -setremotelogin on

# 2. Tambah public key
echo "<pub-key>" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# 3. Firewall — pastikan Tailscale interface diizinkan
# System Settings → Network → Tailscale → Firewall rules
```

### SSH Config (sumber → tujuan)

Tambahkan entry di `~/.ssh/config` mesin sumber:

```ssh
Host <nama-host>
    HostName <nama-host>.tail34fbfd.ts.net
    User mahardhika
    Port 22
    IdentitiesOnly yes
    IdentityFile ~/.ssh/id_ed25519_devgroup
```

---

## Step 4: Mark Fixed

```
Use mark_bug_fixed tool:
- summary: "SSH bidirectional setup completed between <mesin-a> dan <mesin-b>"
```

---

## Step 5: Create Tests

Test koneksi SSH:

```powershell
# Di Windows
ssh helloworld hostname
ssh mac hostname
ssh mmch hostname
```

```bash
# Di macOS
ssh helloworld hostname
ssh mmch hostname
```

```
Use create_tests tool
```

---

## Step 6: Run Tests

Catat hasil test:

```
Use run_tests tool:
- passed: true
- testCommand: "ssh helloworld hostname; ssh mac hostname"
- details: "Bidirectional SSH verified on all 3 nodes"
```

---

## Step 7: Create Documentation

Update `docs/homelab/infra-tailnet-ssh.md` dengan perubahan terbaru:

```
Use create_documentation tool:
- documentationType: "PRD"
- summary: "Updated infra-tailnet-ssh.md with new machine <hostname> onboarding steps"
```

---

## Step 8: Commit & Push

```
Use commit_and_push tool:
- commitMessage: "docs(homelab): add <hostname> SSH setup guide"
```

---

## Step 9: Skip Release

Karena ini perubahan dokumentasi, release tidak diperlukan:

```
Use skip_release tool:
- reason: "Documentation-only change, no version bump needed"
```

---

## Step 10: Complete

```
Use complete_task tool:
- commitMessage: "docs(homelab): add <hostname> SSH setup guide"
```

---

## Quick Reference: Machine States

| Mesin | Tailscale IP | SSH User | Keys |
|---|---|---|---|
| `mmch` | `100.109.164.16` | `mahardhika` | `id_ed25519_devgroup` |
| `helloworld` | `100.90.209.77` | `mahardhika` | sama |
| `mahatmas-macbook-pro` | `100.127.94.70` | `mahardhika` | sama |
