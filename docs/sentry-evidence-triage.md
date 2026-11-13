# Evidence-first Sentry triage

Analysis captured on 2026-11-05 at approximately 03:36 UTC (10:36 WIB). Analysis Todo181 is linked to the still-open remediation worker Todo170. No application fix or Sentry status change was made during this investigation.

## Current inventory

The paginated `is:unresolved` inventory returned 264 unique issues across eight accessible projects, matching the provider count, with no incomplete pagination flags. This is a point-in-time issue inventory, not an atomic snapshot of all events. The requested statistics window is 90 days; it must not be interpreted as proof that every issue's last occurrence falls inside that window.

| Project | Issues | Seen within 24h | Seen within 7d | Last seen over 30d ago |
| --- | ---: | ---: | ---: | ---: |
| ERP | 129 | 18 | 77 | 25 |
| Clinic | 81 | 9 | 32 | 15 |
| Frontend ERP | 38 | 3 | 6 | 19 |
| Todoapp | 13 | 0 | 12 | 0 |
| HRIS | 2 | 0 | 0 | 1 |
| Belajar | 1 | 0 | 0 | 0 |
| Sentry Resolve | 0 | 0 | 0 | 0 |
| Zettly Editor | 0 | 0 | 0 | 0 |
| Total | 264 | 30 | 127 | 60 |

Age is a prioritization signal, never evidence that an issue is fixed. Issue counts also do not equal independent root causes: a shared defect can affect multiple tenants and fingerprints. Performance findings must be distinguished from application exceptions.

## Representative evidence

Twelve issue details and latest-event metadata were inspected. This sample does not establish a resolution verdict for every issue.

- **POS-CLINIC-EF:** the undefined `cart_visible` event occurred at 2026-11-04 10:18 UTC on HELLOWORLD, despite an environment label of `production`. The matching command source now guards the missing result with `?? false`; commit `dcf4f9180` was recorded at 15:13 UTC, after the event. This is a candidate for verification of an existing fix, rather than an immediate new patch.
- **POS-CLINIC-D3:** the latest missing `--customer` option error occurred at 14:59 UTC on 2026-11-04. The same later commit adds that option. Current source contains corresponding command tests. The exact failing invocation still needs confirmation because the sampled latest event lacks a command identifier; the title alone is insufficient to resolve it.
- **Deployment corroboration:** all five inspected Clinic production `current` links point to `v5.0.18`, commit `b2272da5daecfdd7abc2dada0806423a5234325a`. Their release files contain both the customer option and guarded cart output. This proves deployed source presence, not successful replay or absence of recurrence on every tenant.
- **POS-CLINIC-CP:** the latest database connection failure also came from HELLOWORLD while labelled `production`. It needs local runtime/configuration diagnosis before changing production application code.
- **POS-CLINIC-EG / EH:** a Livewire property failure and a scheduled-command failure came from the actual server. They remain separate investigations; an existing cart fix does not establish that either is resolved.
- **ERP-5G / ERP-7J:** latest sampled slow-query events occurred at approximately 03:30 UTC on 2026-11-05, after the observed ERP checkout commit `d5eb5347` dated 2026-11-04 11:13 UTC. Their environments identify the production server. These are current performance investigations, not candidates for closure merely due to age. The serving revision still needs independent deployment corroboration.
- **HRIS-20, HRIS-V and BELAJAR-PROGRAMINGLIVE-3E:** sampled latest events identify the local environment on HELLOWORLD. They belong in coverage reconciliation but must not be presented as established production failures.
- **TODOAPP-3S / 3R:** sampled events lack release attribution; one stack references the user-index migration. Missing deployment and event identity evidence prevents a reliable fixed/unfixed verdict.

## Attribution blockers

All five sampled Clinic events carry the literal release `${CI_COMMIT_SHA:-local}` rather than an actual commit or version. That value cannot identify deployed code. ERP, Todoapp, HRIS and Belajar samples lack a release value. Local events are also inconsistently labelled. Repair release/environment attribution as a separate verified configuration task; do not discard the underlying events.

The managed connector currently returns issue summaries and inventory coverage. It intentionally omits raw event payloads, but also omits the release, environment, application frames, event timestamps and deployment evidence needed for a remediation decision. The new worker therefore needs a bounded, redacted evidence interface before it can safely automate fixes or resolution.

## Required decision process

1. Identify the source issue, project, tenant/host, environment, event fingerprint and event time. Map them to the actual repository and serving release. Missing or conflicting identity remains `needs_evidence`.
2. Search linked Zettly/Factory work, Git history and existing tests for the same failure and cause. Reuse an existing fix or work item; similar titles alone do not establish equivalence.
3. Compare the failing code with the suspected fixing commit and verify commit ancestry in each affected deployed release. Code that exists only locally is `fixed_in_code_pending_deploy`.
4. Reproduce on the affected old revision in an isolated environment when feasible. Run the same meaningful regression on the fixing revision. Do not run destructive replay or customer-data mutations in production.
5. If the existing deployed fix passes, record `existing_fix_pending_verification`, then verify the affected route/command/tenant and examine events since deployment, filtered by environment and release. Lack of traffic or missing telemetry is inconclusive.
6. Create a new code fix only when the failure still reproduces or events prove that the same cause persists on the corrected deployed release. Diagnose infrastructure/configuration and performance findings through their respective paths.
7. Resolve only with recorded evidence: issue/event IDs, affected scope, cause, fixing commit, tests, deployed identity and acceptance checks. Keep reopen/regression handling and coverage reconciliation active. A duplicate links to the verified root issue; it is not silently deleted.

Persist the original source and relations in Zettly, Factory and the monitor throughout this process. Use distinct operational states (`needs_evidence`, `confirmed_active`, `fixed_in_code_pending_deploy`, `existing_fix_pending_verification`, `verified_resolved`, `blocked`) and retain the reason for each transition. Local/test pollution and low-priority findings remain visible rather than automatically marked fixed.

References: [Sentry issue events](https://docs.sentry.io/api/events/retrieve-an-issue-event/), [event filtering](https://docs.sentry.io/api/events/list-an-issues-events/), and [release resolution behavior](https://sentry.io/changelog/2023-8-7-improvements-to-resolving-issues-in-a-release/).
