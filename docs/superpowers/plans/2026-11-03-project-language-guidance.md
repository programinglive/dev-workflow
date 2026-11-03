# Project Language Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `start_task` suggest English for developer-facing project work and multilingual localization for non-English app interfaces.

**Architecture:** Add a short language policy to the existing `start_task` response. Pin the response and the public guidance in tests and project docs; do not add configuration or enforcement that blocks an existing documented project policy.

**Tech Stack:** Node.js, MCP handler tests, Markdown.

**Spec:** User request in this task: English as the project development default; use multilingual app support when another UI language is needed.

## Global Constraints

- Preserve existing workflow gates and project language policies.
- Keep the instruction concise and advisory.
- Include English and the requested locale in suggested app localization.

## Review Focus

- Existing project language policy: wording must explicitly defer when one is documented.
- User-facing translation: guidance must require multilingual localization rather than a single hard-coded locale.
- Commit conventions: task-start reminder must mention commit messages.

---

### Task 1: Add task-start guidance and regression coverage

**Files:**
- Modify: `tools/handler-modules/workflow-handlers.js`
- Modify: `tests/handlers-workflow.test.js`
- Modify: `README.md`
- Modify: `docs/WORKFLOW-BEST-PRACTICES.md`
- Test: `tests/handlers-workflow.test.js`

- [x] Write a failing test that checks the English defaults, multilingual app localization, and existing-policy exception.
- [x] Run the test and confirm it fails because task-start guidance is missing.
- [x] Add the language guidance to the start-task response.
- [x] Document the convention and run focused and full verification.
