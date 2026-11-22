# Installation Guide

DevWorkflow (`@programinglive/dev-workflow`) is a local-first engineering governance MCP server and CLI. It runs completely offline with zero external accounts required.

## Requirements

- **Node.js:** `>=20.0.0` (verified on Node.js 20, 22, and 24)
- **Git:** `>=2.30` (required for worktree isolation and commit verification)
- **Operating Systems:** Windows, macOS, and Linux

## A. Quick Start (Public npm Package — Recommended)

Install globally from npm:

```bash
npm install -g @programinglive/dev-workflow
```

Initialize your local-first profile and verify your environment:

```bash
devwf setup
devwf doctor
```

Expected output from `devwf setup`:

```text
mode: LOCAL_FIRST_STANDALONE
```

> **Note:** Re-running `devwf setup` preserves any existing Zettly credentials, local SQLite history, and profile configuration. It never overwrites existing settings silently.

## B. Non-Interactive & CI Installation

For CI pipelines or headless setups where you explicitly want standalone mode without Zettly:

```bash
devwf setup --skip-zettly --json
devwf doctor --json
```

## C. Development from Source (Contributors)

```bash
git clone https://github.com/programinglive/dev-workflow.git
cd dev-workflow
npm ci
npm test
npx devwf doctor
```

## Updating DevWorkflow

```bash
npm install -g @programinglive/dev-workflow@latest
devwf --version
```
