# Provider Decoupling & Local-First Defaults Specification

**Document Version:** 1.0.0  
**Principle:** 100% Local-First Operation by Default  

---

## 1. Local-First Defaults Matrix

The open-source core must initialize and execute complete workflows without external network access or mandatory cloud accounts:

| Subsystem | Default Local Provider | Optional External Providers | Fallback Behavior When Unconfigured |
|---|---|---|---|
| **Task Tracker** | `LocalSQLiteTaskTracker` | `ZettlyProvider`, `GitHubIssuesProvider`, `LinearProvider` | Tasks stored purely in local SQLite; zero network calls. |
| **Visual Planning** | `LocalMermaidRenderer` | `ZettlyDrawProvider`, `ExcalidrawProvider` | Mermaid code validated locally; SVG rendered via local CLI. |
| **Persistence** | `SQLiteAdapter` (`dev-workflow.db`) | `PostgreSQLAdapter`, `MySQLAdapter` | Uses `better-sqlite3` in current user state directory. |
| **Execution** | `LocalProcessExecutor` | `DockerSandboxExecutor`, `RemoteRunnerExecutor` | Executes commands on local host with argument escaping. |
| **Monitoring** | `LocalDashboard` (`127.0.0.1:3100`) | `FleetMonitor`, `OpenTelemetry` | Serves dashboard locally on loopback; no cloud upload. |
| **Approvals** | `InteractiveCliApproval` | `ZettlyApproval`, `GitHubReviewApproval` | Prompts in terminal or requires local CLI token. |

---

## 2. Graceful Degradation & Capability Discovery

When an optional provider (such as Zettly or Sentry) is unconfigured or unavailable:
1. **Startup Resilience:** The MCP server logs an info message (`Zettly provider disabled (local-only mode)`) and starts in under 200ms without timing out.
2. **Tool Adaptation:**
   - Tools like `get_current_focus` return: `{ status: "local", activeFoci: [] }`.
   - `start_task` records the task purely in local SQLite and sets `taskOrigin = { system: "local", id: taskId }`.
3. **No False Failures:** Missing external API tokens (`ZETTLY_API_TOKEN`, `SENTRY_AUTH_TOKEN`) never cause a tool invocation error on standard engineering tasks.
