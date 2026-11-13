# PocketBase IdentityProvider Contract

**Version:** 1.0.0  

## Interface Specification

`PocketBaseIdentityProvider` implements the standard DevWorkflow `IdentityProvider` contract:

- `authenticate({ email, password, origin })`: Exchanges `activity_users` credentials for a verified session token and identity claims.
- `validateToken(token)`: Validates token format, expiration, and collection scope (`activity_users`, rejecting `_superusers`).
- `getIdentity(subjectId)`: Returns normalized `DeveloperIdentity` (`id`, `email`, `name`, `roles`).
- `getCapabilities()`: Reports `{ canAuthenticatePassword: true, canValidateToken: true, supportsOffline: false }`.
