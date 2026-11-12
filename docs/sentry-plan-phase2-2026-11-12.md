# Sentry zero — phase 2 plan (2026-11-12, after the afternoon session)

Started this morning at 40 unresolved. Now 10. This file covers only what is
left and how to avoid the mistakes made today.

## What went wrong today, once each

| Mistake | Cost | Rule added |
|---|---|---|
| Started ERP work without checking the monitor | One commit duplicated another session's work | Check `list_active_sessions` **before** the first edit, not after |
| Wrote a fix for an issue already fixed upstream | A rebase conflict on three files | `git log -1 -- <file>` before writing any fix |
| Bulk insert filled NOT NULL columns with null | Would have corrupted stock balances | Read column metadata; never guess defaults |
| Trusted a summary instead of the data | Nearly "fixed" a NULL that does not exist | Query the production data before accepting a diagnosis |

## Current ownership — do not start inside these

| Area | Owner session | Files |
|---|---|---|
| ERP transferStock / BTB stock | `erp.beautyworld.co.id` (Mac), `erp-btb-stock-del-fix` (opencode, codex) | `TrTransferStockController`, `TrTransferstockBTBController`, `app/Concerns/InsertsInBulk.php` |
| frontend_erp dashboard N+1 | `frontend_erp` (Mac) | dashboard board loading |
| infra / CPU alert | `bw-server-grooming` | host scripts |

Two sessions are on `erp-btb-stock-del-fix` at once. One of them believes
`ms_stock.Stock_Del` is NULL. It is not: production has **0** NULL rows and both
reported BTB documents carry `'0'`. The real anomaly was 6 rows with an empty
string, and the trait fix for that already shipped as `8959e4f3`.

Resolve the duplicate ownership before anyone touches stock code again.

## What is actually free to work on

| Issue | Project | Why it is safe to take |
|---|---|---|
| ERP-42 | erp | `usageStock/approve`, untouched by every active session |
| ERP-5W | erp | `settings/user/permission`, untouched |
| ERP-7P | erp | `salesReturn`, untouched |
| ERP-7V, ERP-7T, ERP-46 | erp | index/query insight, not insert loops |
| FRONTEND_ERP-39 | frontend_erp | N+1 API call — **conflicts with the Mac session**, hold |
| FRONTEND_ERP-4Y | frontend_erp | HTTP/1.1 overhead — transport, close with a written reason |

Safe order: **ERP-42 → ERP-7P → ERP-5W**, then the three index insights.

## Before the first line of code, every time

1. `list_active_sessions` — if the file area is owned, stop and say so
2. `git log origin/master --since='24 hours ago' -- <file>` — if someone already
   touched it, read their change before writing yours
3. For a bug: query the production data that proves the claimed symptom

## Definition of done per issue

An issue may only be resolved when all of these hold:

- [ ] The cause is proven by data or a stack trace, not inferred from a title
- [ ] The fix is committed and contained in a tag
- [ ] That tag is deployed and the deployed file is checked on the host
- [ ] No new event after the deploy
- [ ] The resolution carries a comment naming the commit and the deployed version

Anything less stays open with a written reason.

## Verification commands that were actually useful today

```bash
# what is deployed, and does the file contain the fix
grep -m1 '"version"' /var/www/erp.beautyworld.co.id/package.json
grep -c 'ms_Stock::insert' <controller>

# did the fix reach production, or is the pipeline still queued
node -e "..." # or infra ci_status / runner_status

# is the claimed data problem real
mysql -e "select count(*) from ms_stock where Stock_Del is null;"
```

## What is deliberately not planned

- Rewriting ERP's deploy path again. It now pushes through the bw-tools runner
  on a tag, verified end to end at v2.41.30.
- Resolving performance insights without a fix or a written technical reason.
- Touching `app/Concerns/InsertsInBulk.php` while three sessions depend on it.

## Next single step

Ask the owner to collapse `erp-btb-stock-del-fix` (opencode) and
`erp-btb-stock-del-fix` (codex) into one owner, then take **ERP-42**.
