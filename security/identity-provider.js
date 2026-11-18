import { registerRuntimeSecret } from "./runtime-secrets.js";

/**
 * Decodes the payload segment of a JWT without trusting unverified role claims.
 *
 * @param {string} token
 * @returns {Record<string, any> | null}
 */
export function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Creates a Local-First IdentityProvider that operates 100% offline without
 * PocketBase or Central Gateway dependencies.
 */
export function createLocalIdentityProvider({ defaultUserId = "local-developer" } = {}) {
  const revokedSubjects = new Set();

  return {
    async getCapabilities() {
      return {
        provider: "local",
        supportsOffline: true,
        canAuthenticatePassword: false,
        canValidateToken: true,
      };
    },

    async authenticate(request = {}) {
      const subjectId = String(request.subjectId || defaultUserId).trim();
      if (revokedSubjects.has(subjectId)) {
        return { ok: false, error: "Developer access has been revoked." };
      }
      const now = Date.now();
      return {
        ok: true,
        claims: {
          subjectId,
          email: String(request.email || `${subjectId}@localhost`),
          name: String(request.name || "Local Developer"),
          subjectType: "human",
          provider: "local",
          roles: ["developer"],
          issuedAt: now,
          expiresAt: now + 24 * 60 * 60 * 1000,
        },
      };
    },

    async validateToken(token) {
      if (!token || typeof token !== "string") {
        return { ok: false, error: "Missing identity token." };
      }
      if (revokedSubjects.has(token)) {
        return { ok: false, error: "Token has been revoked." };
      }
      return {
        ok: true,
        claims: {
          subjectId: defaultUserId,
          subjectType: "human",
          provider: "local",
          roles: ["developer"],
        },
      };
    },

    async getIdentity(subjectId) {
      if (revokedSubjects.has(subjectId)) {
        return null;
      }
      return {
        id: subjectId,
        email: `${subjectId}@localhost`,
        name: "Local Developer",
        roles: ["developer"],
        provider: "local",
      };
    },

    revokeSubject(subjectId) {
      revokedSubjects.add(String(subjectId));
    },
  };
}

/**
 * Creates a PocketBase IdentityProvider backed by the `activity_users` collection.
 * Enforces strict separation between superusers, automated service accounts, and human developers.
 */
export function createPocketBaseIdentityProvider({
  pocketBaseUrl = "https://pocketbase.example.com",
  origin = "https://auth.example.com",
  serviceEmail = "",
  fetchImpl = fetch,
} = {}) {
  const cleanUrl = String(pocketBaseUrl || "").replace(/\/+$/, "");
  const revokedSubjects = new Set();
  const identityCache = new Map();

  return {
    async getCapabilities() {
      return {
        provider: "pocketbase",
        supportsOffline: false,
        canAuthenticatePassword: true,
        canValidateToken: true,
      };
    },

    async authenticate({ email, password, isServiceAccount = false } = {}) {
      if (!email || !password) {
        return { ok: false, error: "Email and password are required." };
      }
      registerRuntimeSecret(password);

      try {
        const res = await fetchImpl(
          `${cleanUrl}/api/collections/activity_users/auth-with-password`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Origin: origin,
            },
            body: JSON.stringify({ identity: email.trim(), password }),
          }
        );

        if (!res.ok) {
          return {
            ok: false,
            status: res.status,
            error: `PocketBase authentication failed (HTTP ${res.status}).`,
          };
        }

        const data = await res.json();
        if (!data || !data.token) {
          return { ok: false, error: "PocketBase response did not include a token." };
        }

        registerRuntimeSecret(data.token);

        const tokenCheck = await this.validateToken(data.token, {
          record: data.record,
          isServiceAccount: isServiceAccount || (serviceEmail && email.trim() === serviceEmail),
        });

        if (!tokenCheck.ok) {
          return tokenCheck;
        }

        if (data.record?.id) {
          identityCache.set(data.record.id, {
            id: data.record.id,
            email: data.record.email || email.trim(),
            name: data.record.name || data.record.username || email.trim(),
            roles: tokenCheck.claims.roles,
            provider: "pocketbase",
          });
        }

        return {
          ok: true,
          token: data.token,
          claims: tokenCheck.claims,
        };
      } catch (err) {
        return {
          ok: false,
          serviceUnavailable: true,
          error: `PocketBase identity service unavailable: ${err.message}`,
        };
      }
    },

    async validateToken(token, { record = null, isServiceAccount = false } = {}) {
      if (!token || typeof token !== "string") {
        return { ok: false, error: "Missing token." };
      }
      registerRuntimeSecret(token);

      const payload = decodeJwtPayload(token);
      if (!payload) {
        return { ok: false, error: "Malformed PocketBase token." };
      }

      // Reject PocketBase _superusers / admin tokens
      if (
        payload.collectionName === "_superusers" ||
        payload.collectionId === "_superusers" ||
        payload.type === "admin"
      ) {
        return {
          ok: false,
          error: "PocketBase _superusers tokens are not permitted; use an activity_users identity.",
        };
      }

      // Check expiration
      const nowSec = Math.floor(Date.now() / 1000);
      if (typeof payload.exp === "number" && payload.exp <= nowSec) {
        return { ok: false, error: "PocketBase token has expired." };
      }

      const subjectId = String(record?.id || payload.id || "");
      if (!subjectId) {
        return { ok: false, error: "Token is missing subject identifier." };
      }

      if (revokedSubjects.has(subjectId)) {
        return { ok: false, error: "Developer access has been revoked." };
      }

      const subjectType = isServiceAccount ? "service" : "human";
      const roles = isServiceAccount ? ["background_service"] : ["developer"];

      return {
        ok: true,
        claims: {
          subjectId,
          email: String(record?.email || payload.email || ""),
          subjectType,
          collection: "activity_users",
          provider: "pocketbase",
          roles,
          issuedAt: payload.iat ? payload.iat * 1000 : Date.now(),
          expiresAt: payload.exp ? payload.exp * 1000 : Date.now() + 600_000,
        },
      };
    },

    async getIdentity(subjectId) {
      if (!subjectId || revokedSubjects.has(subjectId)) return null;
      return identityCache.get(subjectId) || null;
    },

    revokeSubject(subjectId) {
      revokedSubjects.add(String(subjectId));
      identityCache.delete(String(subjectId));
    },
  };
}

/**
 * Selects the appropriate IdentityProvider based on environment configuration.
 * Defaults to LocalIdentityProvider so open-source installations require zero external services.
 */
export function createIdentityProviderFromEnv(env = process.env, options = {}) {
  const pbUrl = (env.POCKETBASE_URL || env.DEVWF_PB_URL || "").trim();
  const profile = (env.DEVWF_PROFILE || "local").trim().toLowerCase();

  if (profile === "internal" || pbUrl) {
    return createPocketBaseIdentityProvider({
      pocketBaseUrl: pbUrl || "https://pocketbase.example.com",
      origin: (env.DEVWF_ORIGIN || "https://auth.example.com").trim(),
      serviceEmail: (env.POCKETBASE_SERVICE_EMAIL || "").trim(),
      ...options,
    });
  }

  return createLocalIdentityProvider(options);
}

const HUMAN_ONLY_GOVERNANCE_ACTIONS = new Set([
  "approve_gate",
  "waive_dod",
  "terminate_agent",
  "authorize_release",
  "modify_policy",
  "pair_device_admin",
]);

/**
 * Evaluates governance authorization independently of authentication.
 * Prevents automated service tokens or unverified agents from approving human gates.
 */
export function evaluateGovernanceAuthorization({ claims, action, resource = null } = {}) {
  if (!claims || typeof claims !== "object" || !claims.subjectId) {
    return {
      allowed: false,
      reason: "Fail-closed: verified identity claims are required for governance actions.",
    };
  }

  if (HUMAN_ONLY_GOVERNANCE_ACTIONS.has(action)) {
    if (claims.subjectType === "service") {
      return {
        allowed: false,
        reason: `Action "${action}" denied: a shared service token cannot impersonate a human approver.`,
      };
    }

    if (claims.subjectType === "agent") {
      return {
        allowed: false,
        reason: `Action "${action}" denied: coding agents cannot self-approve human governance gates.`,
      };
    }

    if (claims.subjectType !== "human" && claims.subjectType !== "device") {
      return {
        allowed: false,
        reason: `Action "${action}" requires a verified human developer identity.`,
      };
    }
  }

  return {
    allowed: true,
    subjectId: claims.subjectId,
    subjectType: claims.subjectType,
    action,
    resource,
  };
}

const READ_PB_TOOLS = new Set([
  "pb_health",
  "pb_list_collections",
  "pb_get_collection",
  "pb_list_records",
]);

const WRITE_PB_TOOLS = new Set([
  "pb_create_record",
  "pb_update_record",
]);

const DESTRUCTIVE_PB_TOOLS = new Set([
  "pb_delete_record",
  "pb_create_collection",
]);

/**
 * Enforces default-deny tool and collection authorization for Central Gateway (`pb_*`) calls.
 */
export function evaluateGatewayToolPolicy({
  toolName,
  collection = "",
  claims = null,
  explicitCapabilities = [],
} = {}) {
  const cleanTool = String(toolName || "").trim();
  const cleanCol = String(collection || "").trim();

  if (!cleanTool.startsWith("pb_")) {
    return { allowed: false, reason: `Unknown gateway tool "${cleanTool}".` };
  }

  // 1. Block any access to _superusers
  if (cleanCol === "_superusers") {
    return {
      allowed: false,
      reason: "Access to collection '_superusers' is strictly prohibited via Central Gateway.",
    };
  }

  // 2. Block writes or queries to the retired activity_tasks collection
  if (cleanCol === "activity_tasks") {
    return {
      allowed: false,
      reason: "Collection 'activity_tasks' is retired. Use Zettly for human planning and DevWorkflow Core for active task execution.",
    };
  }

  // 3. Block mutations to activity_users identity collection
  if (cleanCol === "activity_users" && !READ_PB_TOOLS.has(cleanTool)) {
    return {
      allowed: false,
      reason: "Mutating 'activity_users' records via Central Gateway is forbidden.",
    };
  }

  // 4. Destructive operations require human identity + explicit capability
  if (DESTRUCTIVE_PB_TOOLS.has(cleanTool)) {
    const hasCap = Array.isArray(explicitCapabilities) && explicitCapabilities.includes(cleanTool);
    if (!claims || claims.subjectType !== "human" || !hasCap) {
      return {
        allowed: false,
        reason: `Tool "${cleanTool}" requires verified human identity and explicit capability authorization.`,
      };
    }
    return { allowed: true };
  }

  // 5. Read tools on permitted collections
  if (READ_PB_TOOLS.has(cleanTool)) {
    return { allowed: true };
  }

  // 6. Write tools require authenticated principal
  if (WRITE_PB_TOOLS.has(cleanTool)) {
    if (!claims || !claims.subjectId) {
      return {
        allowed: false,
        reason: `Tool "${cleanTool}" requires an authenticated identity.`,
      };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Default-deny policy triggered for "${cleanTool}".`,
  };
}
