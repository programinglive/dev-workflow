# Focus-aware Dev Workflow implementation plan

Goal: make the existing Zettly Focus lifecycle explicit in MCP, keep one selected focus, link real tasks, and require completed work plus evidence before closing it.

Use the existing owner-authenticated Zettly APIs. Keep credentials in the managed private configuration. Preserve canonical task IDs, source provenance and owner-authored descriptions. Browser and MCP identities may differ; an expected owner mismatch must stop mutations instead of moving data silently.

- [ ] Add owner-aware focus reads, idempotent creation, canonical task linking and verified completion.
- [ ] Add bounded API routes and schemas, task-state persistence, visible focus relations and focus-first guidance.
- [ ] Verify missing/multiple focus, owner mismatch, malformed data, concurrent relink, open work and failed persistence.
- [ ] Run the full suite and independent review; publish through the existing managed release with a current-release guard.
- [ ] Verify the same tool catalog on HELLOWORLD, MMCH and Mac for OpenCode, Codex and AGY; save outcomes before finishing the browser focus.

The current Focus API does not provide transactional compare-and-swap across multiple clients. Re-read after writes, report observed conflicts, and never claim cross-device atomicity. Do not change account ownership or silently close another focus. Existing tasks can finish without a new focus association; new work receives explicit focus-first guidance and can request a required focus guard.
