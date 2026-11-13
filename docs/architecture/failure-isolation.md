# Reliability & Failure Isolation Specification

**Document Version:** 1.0.0  
**Status:** Active Specification  

---

## 1. Failure Isolation Matrix

| Failure Scenario | Execution Impact | Governance Impact | Recovery Mechanism |
| :--- | :--- | :--- | :--- |
| **PocketBase Unreachable** | Active local tasks continue in SQLite WAL | New remote token exchanges fail-closed | Cached valid tokens remain usable until TTL; fallback to local profile when configured |
| **Central Gateway SSE Disconnect** | Local MCP tools continue uninterrupted | `pb_*` / `notify_*` remote calls return explicit service-unavailable warning | Client reconnects with exponential backoff |
| **Zettly API Timeout / 5xx** | Coding session continues without blocking | Todo/Outcome sync queued in durable outbox | Reconciled automatically via `sync_zettly_task` outbox |
| **Android SSE Stream Drop** | Zero impact on server or agents | Tablet status shifts `LIVE` $\rightarrow$ `RECONNECTING` $\rightarrow$ `POLLING` | `ConnectionManager` replays missed events via `Last-Event-ID` or polls `/api/sessions` |
