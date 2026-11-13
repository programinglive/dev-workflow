# PocketBase Security Hardening

**Version:** 1.0.0  

## Security Invariants

1. **Zero Secret Leakage:** PocketBase passwords and issued bearer tokens are registered in `runtime-secrets.js` on load and scrubbed from all outputs.
2. **No APK Credential Embedding:** Android builds (`mobile-app/`) never bundle PocketBase or backend service credentials.
3. **Superuser Rejection:** Tokens belonging to `_superusers` are rejected by `PocketBaseIdentityProvider`.
4. **Service vs Human Separation:** Automated service tokens (`subjectType: "service"`) cannot authorize human-in-the-loop governance gates.
