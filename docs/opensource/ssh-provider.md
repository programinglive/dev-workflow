# Generic SSH Transport Provider

## Overview

Multi-machine fleet synchronization is opt-in and powered by `SSHTransportProvider` (`managed/fleet-providers.cjs`). It works over standard OpenSSH on any network (LAN, VPN, or Tailscale) without hardcoding private hostnames or user paths.

## Security Controls

1. **Non-Interactive Batch Execution:** Always passes `-o BatchMode=yes` so automated fleet checks never hang on password prompts.
2. **Strict Host Key Verification:** Passes `-o StrictHostKeyChecking=yes` by default. If a remote host key changes unexpectedly, the provider aborts immediately and returns `failureCode: "SSH_HOST_IDENTITY_MISMATCH"`.
3. **Cross-Platform Command Encoding:**
   - **Windows (`win32`):** Uses UTF-16LE Base64 with `powershell -NoProfile -EncodedCommand` to prevent shell-quoting or injection hazards.
   - **macOS / Linux (`darwin` / `linux`):** Uses UTF-8 Base64 piped into `base64 -d | sh`.
4. **Failure Isolation:** Unreachable nodes return `SSH_CONNECTIVITY_FAILURE` and are isolated by `FleetOrchestrator` so remaining healthy nodes complete their upgrade.
