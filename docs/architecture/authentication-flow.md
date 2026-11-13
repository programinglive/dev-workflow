# Authentication Flow Architecture

**Document Version:** 1.0.0  
**Status:** Active Specification  

---

## 1. IdentityProvider Abstraction

DevWorkflow defines a pluggable `IdentityProvider` interface (`security/identity-provider.js`):

```javascript
/**
 * @typedef {Object} IdentityClaims
 * @property {string} subjectId - Unique user or device identifier
 * @property {string} email - Verified developer email or local handle
 * @property {"human"|"service"|"device"|"agent"} subjectType - Principal classification
 * @property {string} provider - "local" | "pocketbase"
 * @property {string[]} roles - Verified role identifiers
 * @property {number} issuedAt - Epoch ms
 * @property {number} expiresAt - Epoch ms
 */
```

### Supported Providers
1. **`LocalIdentityProvider` (Default / Open-Source):**
   - Operates 100% offline with zero external network dependencies.
   - Authenticates local CLI users and ephemeral pairing challenges on the loopback/LAN interface.
2. **`PocketBaseIdentityProvider` (Internal / Multi-Device):**
   - Verifies developer credentials and tokens against the PocketBase `activity_users` collection.
   - Distinguishes between human developer sessions and automated background service tokens.

---

## 2. Mobile Companion Pairing & Authentication Flow

1. Developer executes `devwf pair` in the terminal or opens the pairing modal on the DevWorkflow Monitor Server.
2. Server generates a short-lived (180s), single-use cryptographic challenge (`pairingId`, `secret`, `nonce`).
3. Xiaomi Pad 6 scans the QR code (`devwf://pair?...`) and submits `POST /api/v1/mobile/pair/verify`.
4. DevWorkflow validates the challenge and verifies the identity claims via the active `IdentityProvider`.
5. DevWorkflow issues a **scoped device token** (`tok_...`) bound to the device ID and role (`monitor:read`).
6. Backend service credentials are **never** transmitted to the mobile device.
