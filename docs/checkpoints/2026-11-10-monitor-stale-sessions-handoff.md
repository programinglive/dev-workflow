# Monitor stale sessions and CI deployment handoff

Status at 2026-11-10 00:45 WIB: **unfinished; do not claim a live fix**. The
owner requested a checkpoint and will continue in another AI session. Stop
implementation here. No monitor application file has been deployed to bw-tools.

## Canonical work

- Dev Workflow task `60f3d547-1054-4124-a07c-75da2bd4221b`, phase `release`.
- Zettly Todo [#462](https://zettly.programinglive.com/todos/462), still open;
  Draw [#123](https://zettly.programinglive.com/draw/123).
- Factory task `53c0fc9b-7851-4118-9aeb-07a0f764efda`.
- Branch `fix/monitor-stale-session-controls` in
  `D:\code\dev-workflow-mcp-server` on HELLOWORLD. PR
  [#69](https://github.com/programinglive/dev-workflow-mcp-server/pull/69).
  First pushed commit `b5edee04` fixes the dashboard close button and filters
  one exact retired `uji` report. The PR CI jobs were still pending at this
  checkpoint; do not assume they passed.

## Verified operational reconciliation

- Factory task `4d459a45-4147-4dc3-89c8-49e7dd909df0` was `done`. Its stale
  monitor card was closed through `/api/session/close`; Zettly Todo #460 was
  marked complete and its generated status corrected to `completed`.
- Clinic product-search fix was already released as `v5.1.2` at
  `6b4ba00ee2e9b98d9ca93f3f96a917f777eea26b`; Clinic Helper reported
  pipeline `3044646591` successful, and canonical Todo #443 was complete.
  Two superseded Clinic monitor rows were closed through the official API.
  Preserve the old Mac worktree's uncommitted files; the shipped fix came from
  another isolated release worktree.
- The live monitor still reported the synthetic machine `uji` and its silence
  alert. The code fix is not deployed. Other active sessions belong to other
  agents and must not be closed.

## Pending CI deployment change

The branch adds a `deploy-monitor` job to `.github/workflows/ci.yml`,
`scripts/deploy-monitor.ps1`, a pinned public host key, and a focused workflow
test. It changes README and monitor deployment documentation. The job is
restricted to successful pushes to `main`; it uploads only `dashboard.cjs`
and `machines-query.cjs`, checks hashes and syntax, uses exact sudo commands,
restarts `devwf-monitor.service`, checks health and session output, and attempts
rollback on failure. This deployment path is **untested in CI and not live**.
The targeted new test passed (3/3), the PowerShell file parsed, and PyYAML
parsed the workflow. The earlier full suite passed 1433 tests with 27 skipped
before these latest deployment files were added. Run the full suite again.

Provisioning already performed for the proposed pipeline:

- GitHub repository secret `MONITOR_DEPLOY_SSH_KEY` exists. Never print it.
- Dedicated `devwf-monitor-deploy` account exists on bw-tools. Its public key
  fingerprint is `SHA256:Pac9Qohls+1kbl4F1+HJQJP28lJpBkP063iL5XoJHrs`.
  `authorized_keys` permits only MMCH's Tailscale source address
  `100.109.164.16` and has mode 600; its parent `.ssh` has mode 700.
- `/etc/sudoers.d/devwf-monitor-deploy` parsed successfully and permits only
  four exact install commands (new and rollback files) and restarting
  `devwf-monitor.service`. The pinned bw-tools ED25519 host-key fingerprint is
  `SHA256:nnJxOVEj05oEWoShlGIMQXhg4mB38bbbrbPNL0HARNU`.
- The temporary private key on HELLOWORLD was removed after uploading the
  GitHub secret. A temporary MMCH test copy was removed by a `finally` block.
- A login test from MMCH **failed before the authorized_keys file was fixed**:
  PowerShell had written CRLF. The file was replaced with LF and its fingerprint
  and permissions were read back. **Retest login from MMCH**; do not infer it
  works from the corrected file alone.

## Next actions for the new session

1. Read `D:\code\AGENTS.md`, the shared workflow, this repo's AGENTS.md and
   README, and inspect Git/monitor state. Reuse task `60f3d547-1054-4124-a07c-75da2bd4221b`
   and Todo #462. Do not create duplicate tasks or overwrite other sessions.
2. Verify dedicated SSH login from MMCH and the narrow sudo allowlist without
   exposing the key. Inspect `scripts/deploy-monitor.ps1` and CI conditions;
   correct any defects before deployment.
3. Run `npm test`, lint, server build, PowerShell parse, YAML parse, and
   `git diff --check`. Record results in the existing Dev Workflow task.
4. Wait for PR #69 CI to pass; merge through the normal review
   and CI path. The main-branch deploy job must succeed before claiming a live
   fix. Do not copy application files to the server through an ad hoc SSH
   command.
5. Read back `http://100.77.138.14:3100/api/sessions`: expect no `uji`
   machine or alert and a working close control. Then run the required
   `node managed/rollout.cjs` from the reviewed release checkout, verify all
   three devices, finish the task, and record one verified Zettly journal
   outcome. Keep the task open if any gate fails.
