# Setup Wizard & Progressive Integrations

DevWorkflow supports four progressive capability layers without forcing external services:

1. **Layer 1 — Local Standalone (Default):** `devwf setup` initializes `~/.devworkflow/profile.json` in `LOCAL_FIRST_STANDALONE` mode. Zero network calls, zero external accounts.
2. **Layer 2 — AI Coding Clients:** Connect Claude Code, Codex, OpenCode, Antigravity, or any MCP stdio client. See [docs/integrations/](../integrations/generic-mcp-client.md).
3. **Layer 3 — Optional Integrations:**
   - **Zettly (Optional):** Connect your own Zettly instance for planning, Eisenhower prioritization, and retrospectives:
     ```bash
     devwf zettly connect --url https://your-zettly-instance.example
     devwf zettly status
     ```
     Disconnect anytime while preserving local SQLite task history:
     ```bash
     devwf zettly disconnect --confirm
     ```
   - **DevWorkflow Android Companion (Optional):** Remote engineering cockpit for supported Android devices. Pair securely using:
     ```bash
     devwf pair --url http://<your-lan-host>:3100
     ```
4. **Layer 4 — Advanced / Team Infrastructure (Optional):** Central monitor dashboard, fleet diagnostics (`devwf fleet doctor`), and managed release distribution for engineering teams.
