import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getAllToolDefinitions,
  getToolList,
} from "../tools/definitions.js";
import { handleToolCall } from "../tools/handlers.js";
import {
  CORE_TOOL_NAMES,
  STANDARD_ONLY_TOOL_NAMES,
  TOOL_PROFILE_ENV,
  getToolProfile,
  isToolAllowedInProfile,
  resetToolProfileCache,
  resolveToolProfile,
} from "../src/tool-profiles.js";
import { estimateToolCatalogCost } from "../src/tool-profile-cost.js";
import { parseArgs } from "../cli/args.js";
import { runOnboardingSetup, validateToolProfile } from "../cli/onboarding.js";

const ISOLATED_PROFILE_DIR = mkdtempSync(path.join(tmpdir(), "devwf-profile-dir-"));
process.env.DEVWF_PROFILE_DIR = ISOLATED_PROFILE_DIR;
import { buildWorkflowInstructions } from "../workflow-guidance.js";
import { renderDocGateFailure } from "../tools/handler-modules/docs.js";
import { getContinueGuidance } from "../tools/handler-modules/shared.js";
import { withWorkflowState, createRequest, createGitMock, testUtils, bindTaskToRepo } from "./test-helpers.js";

const ALL_TOOL_NAMES = getAllToolDefinitions().map((tool) => tool.name);

function withProfile(profile, fn) {
  const previous = process.env[TOOL_PROFILE_ENV];
  if (profile === null) delete process.env[TOOL_PROFILE_ENV];
  else process.env[TOOL_PROFILE_ENV] = profile;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[TOOL_PROFILE_ENV];
    else process.env[TOOL_PROFILE_ENV] = previous;
  }
}

async function withProfileAsync(profile, fn) {
  const previous = process.env[TOOL_PROFILE_ENV];
  if (profile === null) delete process.env[TOOL_PROFILE_ENV];
  else process.env[TOOL_PROFILE_ENV] = profile;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[TOOL_PROFILE_ENV];
    else process.env[TOOL_PROFILE_ENV] = previous;
  }
}

function exposedNames() {
  return getToolList().map((tool) => tool.name);
}

function unavailableNames(profile) {
  return ALL_TOOL_NAMES.filter((name) => !isToolAllowedInProfile(name, profile));
}

/**
 * Match a tool name as a whole token. Prevents `audit` from matching inside
 * `security_audit`, or `next_steps` from matching inside `nextSteps`.
 */
function mentionsTool(text, name) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
  return pattern.test(text);
}

function assertNoUnavailableMentions(text, profile, label) {
  const offenders = unavailableNames(profile).filter((name) => mentionsTool(text, name));
  assert.deepEqual(
    offenders,
    [],
    `${label} must not mention tools unavailable in profile '${profile}': ${offenders.join(", ")}`,
  );
}

async function callTool(name, args, workflowState, git, exec) {
  return handleToolCall({
    request: createRequest(name, args),
    normalizeRequestArgs: (value) => ({ args: value, error: null }),
    workflowState,
    exec: exec || (async () => ({ stdout: "" })),
    git: git || createGitMock(),
    utils: testUtils,
  });
}

test("default profile exposes all 66 tools", () => {
  withProfile(null, () => {
    assert.equal(exposedNames().length, 66);
    assert.equal(getAllToolDefinitions().length, 66);
  });
});

test("core profile exposes exactly the 18 lifecycle tools", () => {
  withProfile("core", () => {
    assert.deepEqual([...exposedNames()].sort(), [...CORE_TOOL_NAMES].sort());
    assert.equal(exposedNames().length, 18);
  });
});

test("standard profile exposes core plus 12 operational tools", () => {
  withProfile("standard", () => {
    const names = exposedNames();
    assert.equal(names.length, 30);
    assert.deepEqual(
      [...names].sort(),
      [...CORE_TOOL_NAMES, ...STANDARD_ONLY_TOOL_NAMES].sort(),
    );
  });
});

test("full profile exposes every registered tool", () => {
  withProfile("full", () => {
    assert.equal(exposedNames().length, 66);
  });
});

test("unknown profile values fall back to full instead of hiding tools", () => {
  assert.equal(resolveToolProfile("nonsense"), "full");
  assert.equal(resolveToolProfile(""), "full");
  withProfile("nonsense", () => {
    assert.equal(exposedNames().length, 66);
  });
});

test("devwf setup parses --profile and rejects an unknown value", () => {
  const parsed = parseArgs(["setup", "--profile", "standard"]);
  assert.equal(parsed.profile, "standard");
  assert.equal(validateToolProfile("CORE"), "core");
  assert.throws(() => validateToolProfile("tiny"), /Unknown tool profile/);
});

test("devwf setup --profile persists the choice and the server resolves it without the env var", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "devwf-setup-home-"));
  const previousDir = process.env.DEVWF_PROFILE_DIR;
  try {
    const result = await runOnboardingSetup({
      env: {},
      home,
      skipZettly: true,
      toolProfile: "standard",
    });
    assert.equal(result.toolProfile, "standard");

    delete process.env[TOOL_PROFILE_ENV];
    process.env.DEVWF_PROFILE_DIR = path.join(home, ".devworkflow");
    resetToolProfileCache();
    assert.equal(getToolProfile(), "standard");

    // The environment variable still wins over the persisted default.
    process.env[TOOL_PROFILE_ENV] = "core";
    assert.equal(getToolProfile(), "core");
  } finally {
    delete process.env[TOOL_PROFILE_ENV];
    process.env.DEVWF_PROFILE_DIR = previousDir;
    resetToolProfileCache();
    rmSync(home, { recursive: true, force: true });
  }
});

test("token estimate shrinks with the profile and is labelled as an estimate", () => {
  const core = estimateToolCatalogCost("core");
  const standard = estimateToolCatalogCost("standard");
  const full = estimateToolCatalogCost("full");

  assert.equal(core.tools, 18);
  assert.equal(standard.tools, 30);
  assert.equal(full.tools, 66);
  assert.ok(core.estimatedTokens < standard.estimatedTokens);
  assert.ok(standard.estimatedTokens < full.estimatedTokens);
  for (const cost of [core, standard, full]) {
    assert.match(cost.estimator, /estimate/i);
    assert.equal(cost.registeredTools, 66, "the denominator is the whole catalog");
    assert.ok(cost.estimatedTokens > 0);
  }
});

test("tools/call refuses a tool outside the active profile with a clear message", async () => {
  await withProfileAsync("core", async () => {
    await withWorkflowState(async (workflowState) => {
      workflowState.state.currentPhase = "coding";
      workflowState.state.bugFixed = true;
      workflowState.state.testsCreated = true;
      await workflowState.save();

      const response = await callTool("skip_tests", { reason: "not needed" }, workflowState);
      const text = response.content[0].text;

      assert.match(text, /not available in profile 'core'/);
      assert.match(text, /DEVWF_TOOL_PROFILE=standard/);
      assert.match(text, /DEVWF_TOOL_PROFILE=full/);
    });
  });
});

test("tools/call still runs a tool that belongs to the active profile", async () => {
  await withProfileAsync("core", async () => {
    await withWorkflowState(async (workflowState) => {
      workflowState.state.currentPhase = "coding";
      await workflowState.save();

      const response = await callTool("get_workflow_status", {}, workflowState);
      assert.doesNotMatch(response.content[0].text, /not available in profile/);
    });
  });
});

test("workflow guidance never names a tool hidden by the active profile", () => {
  for (const profile of ["core", "standard", "full"]) {
    assertNoUnavailableMentions(buildWorkflowInstructions(profile), profile, "workflow instructions");
  }
});

test("continue guidance never names a tool hidden by the active profile", () => {
  const phases = ["coding", "testing", "documentation", "ready", "commit", "release", "ready_to_complete"];
  for (const profile of ["core", "standard", "full"]) {
    for (const phase of phases) {
      const text = getContinueGuidance(
        {
          taskDescription: "profile check",
          currentPhase: phase,
          testsCreated: true,
          testsPassed: true,
          testCommand: "npm test",
          definitionOfDone: [],
        },
        profile,
      );
      assertNoUnavailableMentions(text, profile, `continue guidance for '${phase}'`);
    }
  }
});

test("documentation gate in the core profile offers no waiver tool", () => {
  withProfile("core", () => {
    const text = renderDocGateFailure({
      changedFiles: ["src/app.js"],
      list: "   • M src/app.js",
      readmeLine: "README unchanged.",
    });
    assert.doesNotMatch(text, /waive_documentation/);
    assert.match(text, /DEVWF_TOOL_PROFILE=full/);
  });
});

test("documentation gate in the full profile still offers the waiver", () => {
  withProfile("full", () => {
    const text = renderDocGateFailure({
      changedFiles: ["src/app.js"],
      list: "   • M src/app.js",
      readmeLine: "README unchanged.",
    });
    assert.match(text, /waive_documentation/);
  });
});

test("core profile drives the whole task lifecycle with a git mock", async () => {
  await withProfileAsync("core", async () => {
    await withWorkflowState(async (workflowState) => {
      await bindTaskToRepo(workflowState);
      workflowState.state.currentPhase = "coding";
      await workflowState.save();
      const commands = [];
      let workingChanges = true;
      const exec = async (command) => {
        commands.push(command);
        if (command.startsWith("git commit") || command.startsWith("git push")) workingChanges = false;
        if (command === "git status --porcelain") {
          return {
            stdout: workingChanges
              ? " M tests/core-lifecycle.test.js\nM src/app.js\nM README.md"
              : "",
          };
        }
        return { stdout: "" };
      };
      const git = createGitMock({
        hasWorkingChanges: async () => workingChanges,
        hasTestChanges: async () => true,
        getStagedChanges: async () => [
          { status: "M", path: "tests/core-lifecycle.test.js" },
          { status: "M", path: "src/app.js" },
          { status: "M", path: "README.md" },
        ],
        getStatusOutput: async () =>
          workingChanges ? "M  tests/core-lifecycle.test.js\nM  src/app.js\nM  README.md" : "",
        workingTreeSummary: () =>
          workingChanges
            ? {
                hasChanges: true,
                lines: ["M tests/core-lifecycle.test.js", "M src/app.js", "M README.md"],
              }
            : { hasChanges: false, lines: [] },
      });

      const steps = [];
      const run = async (name, args) => {
        const response = await callTool(name, args, workflowState, git, exec);
        const text = response.content[0].text;
        steps.push({ name, text });
        return text;
      };

      assert.match(
        await run("start_task", {
          description: "Core profile lifecycle verification",
          type: "feature",
          definitionOfDone: ["core lifecycle verified with a git mock"],
          plan: ["record flow", "prove fix", "record tests", "document", "commit", "release", "close"],
          acknowledgeInstructions: true,
        }),
        /Task Started/,
      );
      assert.match(
        await run("create_feature_flow", {
          mermaidCode: "flowchart TD\n  A[Start] --> B[Close]",
          description: "Core lifecycle flow",
        }),
        /Feature flow recorded/,
      );
      const preflight = workflowState.state.preflight || {};
      assert.match(
        await run("acknowledge_instructions", {
          fingerprint: preflight.preflightFingerprint || preflight.readme?.fingerprint,
          scope: preflight.projectRoot,
        }),
        /Instructions acknowledged/,
      );
      assert.match(await run("mark_bug_fixed", { summary: "Implemented the feature" }), /marked as fixed/i);
      assert.match(await run("create_tests", { summary: "Added coverage" }), /Tests recorded/i);
      assert.match(
        await run("run_tests", { passed: true, testCommand: "npm test" }),
        /All tests passed/,
      );
      assert.match(
        await run("create_documentation", {
          documentationType: "README",
          files: ["README.md"],
          summary: "Documented the core profile lifecycle",
        }),
        /Documentation created\/updated/i,
      );
      assert.match(await run("mark_dod_item", { id: "dod-1", evidence: "core lifecycle proven by test" }), /dod-1|terbukti/i);
      assert.match(await run("check_ready_to_commit", {}), /ALL CHECKS PASSED/i);
      assert.match(
        await run("commit_and_push", { message: "feat: verify core profile lifecycle" }),
        /Commit and push completed/i,
      );
      await run("perform_release", { command: "npm run release:patch" });
      assert.equal(workflowState.state.released, true, "perform_release must mark the task released");
      assert.match(
        await run("complete_task", { commitMessage: "feat: verify core profile lifecycle" }),
        /completed|selesai/i,
      );

      for (const step of steps) {
        assertNoUnavailableMentions(step.text, "core", `response of '${step.name}'`);
      }
    });
  });
});
