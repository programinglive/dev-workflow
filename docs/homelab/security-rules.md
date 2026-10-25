# Security Rules

Aturan keamanan yang berlaku untuk seluruh homelab **programinglive**.

---

## 1. Kunci & Credential

- Private keys dan tokens tetap di mesin yang membuatnya
- Public key boleh disebar dan didaftarkan di mesin lain
- Token GitHub, GitLab, Cloudflare, Tailscale **tidak pernah** hardcode di code
- Gunakan `.env`, GitHub secrets, atau environment variables

---

## 2. SSH

- **Jangan** buka port 22 di router atau ke internet publik
- SSH ingress hanya dari Tailscale CGNAT `100.64.0.0/10`
- **Jangan** disable host key verification (`StrictHostKeyChecking ask` tetap aktif)
- **Jangan** aktifkan built-in Administrator/root account untuk SSH
- Private keys tidak pernah di-copy antar mesin

---

## 3. Repository

- Repo homelab-related (`mmch`, `helloworld`, `mac-optimization`) adalah **private**
- Setelah commit, cek `git log` dan `git diff --cached` untuk memastikan tidak ada credential yang tercecer
- `.env`, `.env.*`, `node_modules/`, `.state/` sudah di-gitignore

---

## 4. Firewall

| Mesin | Aturan |
|---|---|
| MMCH | TCP 22 hanya dari `100.64.0.0/10` |
| HELLOWORLD | TCP 22 hanya dari `100.64.0.0/10` |
| Mac | SSH via Tailscale interface, firewall macOS allow |

Tidak ada port forwarding di router untuk layanan internal.

---

## 5. Tailscale

- MagicDNS enabled tailnet-wide
- Gunakan hostname MagicDNS (`helloworld.tail34fbfd.ts.net`) alih-alih IP statis
- Access control: jangan share auth key yang bersifat long-lived kecuali dibutuhkan
- Consider enable Tailnet Lock untuk enforce device compliance (opsional)

---

## 6. Checklist Sebelum Commit

Gunakan prompt `pre_commit_checklist` dari dev-workflow MCP server, atau manual cek:

- [ ] Tidak ada token/key di diff
- [ ] Tidak ada file `.env` yang ter-commit
- [ ] Public key yang disebar hanya public (bukan private)
- [ ] SSH config tidak mengandung path key pribadi yang sensitive

---

## 7. Incident Response

Jika tercuri atau tercetus:

1. **Rotate credential** — generate key/token baru
2. **Revoke lama** — nonaktifkan di panel masing-masing (GitHub, GitLab, Cloudflare, Tailscale)
3. **Audit** — cek log akses dan commit yang mungkin terpengaruh
4. **Update** — ganti di semua mesin yang menggunakannya
5. **Document** — catat di `docs/homelab/` jika ada perubahan konfigurasi keamanan
