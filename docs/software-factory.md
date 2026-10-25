# AI Software Factory Architecture (`factory.programinglive.com`)

This document outlines the architecture for evolving the `dev-workflow-mcp-server` into a full **AI Software Factory OS**, connecting local agentic development with centralized factory orchestration at `factory.programinglive.com`.

---

## 🏭 What is an AI Software Factory?

An AI Software Factory is a structured, automated software production pipeline where specialized AI agents collaborate under strict engineering discipline:

1. **Intake & Specification**: Requirements are brainstormed and converted into formal specs and Mermaid feature flows (`superpowers:brainstorming`).
2. **Planning & Architecture**: Tasks are broken down into granular, testable execution units (`superpowers:writing-plans`).
3. **Autonomous TDD Implementation**: Subagents implement features following RED-GREEN-REFACTOR TDD (`superpowers:test-driven-development`).
4. **Automated Quality Gates**: Code is linted, tested, and reviewed by automated reviewers before merge (`dev-workflow` MCP verification).
5. **Continuous Telemetry & Release**: Releases are recorded, versioned, and synced to the central factory dashboard at `factory.programinglive.com`.

---

## 🌐 Connecting to `factory.programinglive.com`

When deployed and connected to `factory.programinglive.com`, the factory gateway provides:

- **Centralized Telemetry**: Aggregates task history, test pass rates, and token efficiency (powered by RTK) across all homelab and production nodes.
- **Webhook Receivers**: Triggers automated factory runs upon GitHub/GitLab issues or pull requests.
- **Multi-Agent Orchestration**: Dispatches specialized worker agents (Architect, Coder, QA, DevOps) to repositories via remote MCP or webhooks.

---

## 🛠️ Factory API Endpoints (`web/server.js`)

The built-in web dashboard and API server expose factory endpoints:

- `GET /api/factory/status` — Returns factory node health, active tasks, and RTK token savings metrics.
- `POST /api/factory/webhook` — Receives external triggers (GitHub/GitLab/Cloudflare) to initiate automated workflows.
- `GET /api/factory/telemetry` — Exports task completion summaries and execution logs for central aggregation.

---

## 🚀 Roadmap to Full Factory Operations

1. **Phase 1: Local Discipline & Compression** (Current)
   - Enforce TDD and workflow steps locally via MCP.
   - Compress command outputs with RTK.
   - Guide agents using Superpowers skills.
2. **Phase 2: Dashboard & Metrics** (Current)
   - Local Next.js dashboard (`npm run web` on port 3111).
3. **Phase 3: Domain Integration (`factory.programinglive.com`)** (Next)
   - Deploy API server to cloud/homelab infrastructure.
   - Configure DNS and SSL for `factory.programinglive.com`.
   - Enable webhook syncing and centralized telemetry.
