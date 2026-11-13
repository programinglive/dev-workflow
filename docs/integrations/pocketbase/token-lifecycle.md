# PocketBase Token Lifecycle & Caching

**Version:** 1.0.0  

## Lifecycle Rules

1. **Issuance:** Obtained via `POST /api/collections/activity_users/auth-with-password` with explicit `Origin` header.
2. **In-Memory Caching:** Cached for `10 minutes` (`TOKEN_TTL_MS = 600_000`) keyed by `pocketBaseUrl|email`.
3. **Hot Credential Reload:** On `400/401` rejection, `refreshFactoryCredentials()` checks the local MCP configuration file for rotated credentials and retries once before failing.
4. **Revocation & Expiry:** Expired or rejected tokens are immediately evicted via `clearTokenCache()`.
