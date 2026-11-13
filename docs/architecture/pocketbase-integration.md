# PocketBase Identity & Metadata Integration

**Document Version:** 1.0.0  
**Status:** Active Specification  

---

## 1. Architectural Role

PocketBase serves as the **Central Identity Authority** and **Shared Metadata Store** for internal multi-device deployments.

- **Collection of Record for Identity:** `activity_users`
- **Retired Legacy Systems:** `activity_tasks` and the legacy Factory task queue are permanently decommissioned. Active tasks reside exclusively in Zettly (Human Planning) and DevWorkflow Core (`dev-workflow.db`).
- **Superuser Isolation:** PocketBase `_superusers` credentials are administrative only and are explicitly rejected by application authentication flows.

---

## 2. Authentication Exchange Contract

Backend services authenticate against PocketBase via:

```http
POST /api/collections/activity_users/auth-with-password
Content-Type: application/json
Origin: https://auth.example.com

{
  "identity": "developer@example.com",
  "password": "<redacted>"
}
```

### Security Controls
1. **Runtime Secret Registration:** All passwords and issued bearer tokens are immediately registered with `registerRuntimeSecret()` so they are automatically redacted from logs, exceptions, and MCP tool responses.
2. **Bounded Token Caching:** Issued tokens are cached in memory with a strict TTL (`10 minutes`).
3. **Optional Zero-Trust Access Headers:** Supports `CF-Access-Client-Id` and `CF-Access-Client-Secret` when PocketBase is protected behind a Zero-Trust access proxy.
