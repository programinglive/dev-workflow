# Fleet Provider Contracts

## 1. LocalTransportProvider

Executes runtime verification, staging, and process inspection on the local workstation without requiring SSH, Tailscale, or external network infrastructure.

- **Supported Platforms:** Windows (`win32`), macOS (`darwin`), Linux (`linux`)
- **Contract Methods:**
  - `execute({ command, timeoutMs }) -> Promise<{ ok, exitCode, stdout, stderr, transport: 'local', outcomeStatus }>`

## 2. SSHTransportProvider

Executes remote supervisor commands across enrolled fleet nodes over SSH with least-privilege flags.

- **Security Requirements:**
  - Enforces `-o BatchMode=yes` (never blocks on interactive password prompts)
  - Enforces `-o StrictHostKeyChecking=yes` (detects `SSH_HOST_IDENTITY_MISMATCH`)
  - Enforces bounded `ConnectTimeout` (classifies unreachable nodes as `SSH_CONNECTIVITY_FAILURE`)
- **Cross-Platform Shell Encoding:**
  - **Windows (`win32`):** Encodes scripts as UTF-16LE Base64 and invokes `powershell -NoProfile -EncodedCommand <payload>`.
  - **macOS / Linux (`darwin` / `linux`):** Encodes scripts as UTF-8 Base64 and invokes `echo <payload> | base64 -d | sh`.

## 3. AgentLifecycleAdapter

Provides capability discovery, durable session checkpointing, and verified session resume per AI coding client (`opencode`, `codex`, `antigravity`).

- **Contract Methods:**
  - `getCapabilities() -> Record<AgentName, CapabilityDescriptor>`
  - `createSessionCheckpoint(params) -> Promise<{ ok, checkpoint, file }>`
  - `resumeSession({ checkpointId, expectedSessionKey }) -> Promise<ResumeResult>`
