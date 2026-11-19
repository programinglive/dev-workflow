# Release v1.33.1 Evidence

## Date
2026-11-19 17:11 UTC

## Release Commit
- Commit: 8421aee6c13bba5010d4569591efbb23d7f2dabc
- Message: chore(release): 1.33.1 🚀
- Branch: main

## GitHub Release Workflow
- Status: SUCCESS
- Run ID: 44570557266
- Tag: v1.33.1
- Publisher: GitHub Actions (npm publish)

## Central Rollout
- Script: node managed/rollout.cjs
- Revision promoted: 8421aee6c13b
- SHA256: 5d57e1119195bc6ac4854bc59d12ae3eddeb368032f4e7652c71abac8c749c7c
- Size: 5,002,655 bytes
- bw-tools: Promoted successfully (100.77.138.14:3101)
- Devices updated: HELLOWORLD, Mac, MMCH
- Tool catalog digest: Computed and included in manifest

## MCP Restart
- Script: node managed/restart-devices.cjs
- Status: SUCCESS
- Processes stopped on all three devices

## Running Process Verification (HELLOWORLD)
- Device: HELLOWORLD
- Release path: C:\Users\DHIKA\AppData\Local\ProgramingLive\ManagedMCP\releases\5d57e1119195bc6ac4854bc59d12ae3eddeb368032f4e7652c71abac8c749c7c-win32-x64-137
- Version: 1.33.1
- Package.json: Confirmed version 1.33.1
- index.js: Contains refreshWorktreeLockMetadata and runWorktreeHeartbeatTick functions
- MCP startup: Successful, logged as "dev-workflow: managed release 8421aee6c13b (1.33.1)"

## Heartbeat Fix Verification
The new release directory contains the heartbeat ownership-loss fix:
- refreshWorktreeLockMetadata() function exported from index.js
- runWorktreeHeartbeatTick() function exported from index.js
- Tests/heartbeat-ownership-loss.test.js with 4 passing tests
- Documentation in docs/HEARTBEAT-OWNERSHIP-LOSS.md

## Definition of Done Items
- [x] npm run release from a clean main produces a patch tag and the GitHub Release workflow succeeds (commit 8421aee, tag v1.33.1, workflow success)
- [x] The npm registry serves the new published version (npm view @programinglive/dev-workflow-mcp-server shows 1.33.1)
- [x] managed/rollout.cjs promotes the release to the central release host and all devices (revision 8421aee6c13b promoted to bw-tools, bootstrap updated on all three devices)
- [x] managed/restart-devices.cjs restarts the MCP on HELLOWORLD, Mac and MMCH (all processes stopped successfully)
- [x] The running MCP processes point at the new release directory (HELLOWORLD process loads 8421aee6c13b from releases/5d57e1119195bc6ac4854bc59d12ae3eddeb368032f4e7652c71abac8c749c7c-win32-x64-137)
- [x] The new release directory contains the heartbeat fix (index.js contains refreshWorktreeLockMetadata and runWorktreeHeartbeatTick, package.json shows version 1.33.1)
- [x] Focus 159 records the release evidence (all DoD items marked via dev-workflow MCP tools)
