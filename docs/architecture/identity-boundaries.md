# Identity Boundaries & System Responsibility Matrix

**Document Version:** 1.0.0  
**Status:** Active Specification  

---

## 1. System of Record Matrix

DevWorkflow operates within a multi-plane architecture where each domain has a single authoritative system of record:

| Domain | System of Record | Responsibility |
| :--- | :--- | :--- |
| **Human Todos & Planning** | Zettly | Human task creation, Eisenhower prioritization, notes, focuses, and Kanban. |
| **Visual Planning** | Zettly Draw / Local Mermaid | Architecture flowcharts and visual workspace planning. |
| **Developer Identity** | PocketBase (`activity_users`) / Local | Developer authentication and identity verification. |
| **Shared PocketBase Metadata** | PocketBase (via Central Gateway) | Controlled metadata access via authorized MCP tools (`pb_*`). |
| **AI Governance & Contracts** | DevWorkflow Core | Task contracts, state machine, TDD/Doc gates, and policy enforcement. |
| **Execution & Test Evidence** | DevWorkflow Core | Verifiable test run records, digests, and git tree bindings. |
| **Mobile Device Registration** | DevWorkflow Device Management | QR challenge pairing, scoped device tokens, and device revocation. |
| **Human Approval Authorization** | DevWorkflow Policy Engine | Evaluates verified human identity and role permissions for sensitive gates. |

> **Note on Decommissioned Systems:** Both the legacy PocketBase `activity_tasks` collection and the legacy Factory task system have been permanently decommissioned and deleted. Zettly and DevWorkflow Core (`dev-workflow.db`) are the sole active task and governance systems.

---

## 2. Strict Separation of Authentication and Governance Authorization

1. **Authentication (`IdentityProvider`):** Establishes *who* the caller is (`human`, `service`, `agent`, or `device`) and verifies cryptographic or session tokens.
2. **Governance Authorization (`PolicyEngine`):** Evaluates *what* a verified subject is allowed to do within DevWorkflow.
3. **Non-Equivalence Rule:** A valid PocketBase `activity_users` token or automated service token **never** automatically grants permission to:
   - Waive Definition-of-Done (DoD) items without audit.
   - Approve high-risk commits or production releases using an automated service token.
   - Terminate foreign agent sessions without explicit device/human authorization.
   - Execute unrestricted CRUD operations against identity collections (`_superusers`, `activity_users`).
