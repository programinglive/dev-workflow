# Sentry Zero — execution plan (2026-11-12)

Goal: **zero unresolved Sentry issues across `erp`, `frontend_erp`, `pos-clinic` and `todoapp`.**

Started at 40 unresolved. 15 closed with written reasons. 25 remain, of which
ERP-2Z already has a committed fix waiting for a release.

## Rules that make this honest

1. **Never resolve without evidence.** Every resolution carries a comment: either
   the commit that fixed it, or the date after which no event was recorded.
2. **A fix is not done until it is deployed.** Resolving before the release
   means Sentry will reopen it, or worse, hide a live bug.
3. **Do not touch an issue another session owns.** Check
   `list_active_sessions` before starting a cluster.
4. **Performance insights are not closed silently.** Each N+1 gets either a
   query fix or a written technical reason.
5. **One issue = one verification.** After each fix, confirm no new event for
   24h (or a release marker) before resolving.

## Current facts

| Level | Open | Notes |
|---|---|---|
| error | 9 | 3 owned by another session (memory) |
| warning | 4 | 1 permission, 3 query insight |
| info | 11 | N+1 and slow query |
| fatal | 0 | ERP-2Z fixed, awaiting release |

---

## Phase 0 — Baseline (do first)

- [ ] Run `list_sentry_issues` with `is:unresolved` and save the snapshot
- [ ] Confirm no active session owns the cluster you are about to touch
- [ ] Record the exact open count in the tracking Todo

**Exit:** a snapshot file and a confirmed owner list.

## Phase 1 — Ship what is already fixed

- [ ] ERP: cut release from `master` (contains `32c23579`)
- [ ] Deploy to `erp.beautyworld.co.id`
- [ ] Confirm the live blade no longer calls `auth()->user()` (grep on host)
- [ ] Wait 24h or until a sentry release marker is set
- [ ] Resolve **ERP-2Z** with a comment naming the commit and the deploy

**Exit:** ERP-2Z resolved with release evidence.

## Phase 2 — Host and configuration faults (no application logic)

These are the cheapest real wins: they are environment state, not code paths.

- [ ] **POS-CLINIC-EB** `touch(): Utime failed`
  - [ ] Find the file the handler touches (event stack) on the DB/app host
  - [ ] Check owner and mode of `storage/`, `storage/framework/*`, and the media disk
  - [ ] Align owner with the php-fpm user across all 10 tenants
  - [ ] Verify by reproducing the scheduled command manually
  - [ ] Resolve with the permission change recorded
- [ ] **POS-CLINIC-EW** `Please provide a valid cache path`
  - [ ] Same class: `storage/framework/{cache,sessions,views}` missing or unreadable
  - [ ] Create and chown on every tenant, then `php artisan optimize:clear`
  - [ ] Resolve with the tenant list that was repaired
- [ ] **ERP-7W** `Table 'tr_message_h' already exists`
  - [ ] Make the migration idempotent (`hasTable` guard) or remove the duplicate
  - [ ] Run migration on a copy first, then production
  - [ ] Resolve with the commit

**Exit:** three issues closed by configuration, verified by reproduction.

## Phase 3 — Application defects

- [ ] **POS-CLINIC-DE** `PublicPropertyNotFoundException` (Livewire)
  - [ ] Fetch the event stack, identify the component and property
  - [ ] Fix the binding or guard the property
  - [ ] Regression test, release, verify, resolve
- [ ] **FRONTEND_ERP-57** `AxiosError 404`
  - [ ] Fetch the failing URL from the event
  - [ ] Fix the endpoint or the caller
  - [ ] Release, verify, resolve
- [ ] **TODOAPP-6G** `RelationNotFoundException`
  - [ ] Fetch the model and relation name
  - [ ] Add or correct the relation, or fix the caller
  - [ ] Release with a Zettly tag, verify, resolve
- [ ] **POS-CLINIC-EV** deadlock on `receipt_print_jobs`
  - [ ] Add a bounded retry around the transaction
  - [ ] Reduce lock scope, or make the update skippable when possible
  - [ ] Release, verify, resolve

**Exit:** four issues closed by code with regression evidence.

## Phase 4 — Performance (14 insights)

Order by reported volume, not alphabetically.

- [ ] Fix the highest-count N+1 first: **ERP-37** (165), **ERP-2K** (64),
  **ERP-53** (37), **ERP-5J** (33), **ERP-31** (31), **ERP-42** (10)
  - [ ] For each: fetch the event, find the query, add the missing eager load
  - [ ] Add a regression test asserting a bounded query count
  - [ ] Release, verify the count stops growing, resolve
- [ ] Fix **FRONTEND_ERP-39** `N+1 API Call` (142) — batch the client requests
- [ ] **ERP-59** `Slow DB Query` — review the index; add one if it is missing
- [ ] **ERP-7V / ERP-7T / ERP-46** `Inefficient Database Queries` — same treatment
- [ ] **FRONTEND_ERP-4Y** `HTTP/1.1 Overhead` — this is transport, not code
  - [ ] Close with a technical note (HTTP/2 termination at the load balancer)

**Exit:** every N+1 either fixed or closed with a written technical reason.

## Phase 5 — Handover, never steal

- [ ] **ERP-62 / ERP-69 / ERP-77** memory exhausted
  - [ ] Confirm the Mac session still owns them via `list_active_sessions`
  - [ ] If that session ends without a fix, take them over explicitly with
        `handoff_task` or a documented takeover
  - [ ] Do not resolve them on someone else's behalf

**Exit:** ownership is explicit for all three.

## Phase 6 — Prove zero

- [ ] Re-run the inventory for 30d
- [ ] Every remaining issue must have either a fix commit or a written reason
- [ ] List any issue that genuinely cannot be fixed (external vendor, accepted
      risk) in the closing note rather than hiding it
- [ ] Close the tracking Todo with the final count and the exceptions

**Exit:** open count is 0, or every non-zero item is documented by name.

---

## Suggested order of work

1. Phase 0, then Phase 1 (release ERP — it is already fixed)
2. Phase 2 (host faults — fastest real reduction, no code)
3. Phase 3 (application defects, one release per repo)
4. Phase 4 (performance, longest; do it last so it never blocks the rest)
5. Phase 5 and Phase 6

## What "done" means

Not a number. Done means: **no unresolved issue is both unexplained and unfixed.**
A closed issue without a commit or a written reason is a lie, and Sentry will
reopen it the moment the code runs again.
