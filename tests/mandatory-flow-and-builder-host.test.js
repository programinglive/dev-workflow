import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBuildState } from "../build-monitor.js";
import { generateDefaultFlow } from "../tools/handler-modules/workflow-handlers.js";
import { flowGraph } from "../zettly-drawing.js";
import { MANDATORY_FLOW_RULE, WORKFLOW_INSTRUCTIONS } from "../workflow-guidance.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generateDefaultFlow creates valid Mermaid flow parsable by flowGraph", () => {
  const flow = generateDefaultFlow("Refactor invoice processor and calculate tax", [
    "Inspect existing invoice schema",
    "Add tax calculation engine",
    "Run integration tests",
  ]);
  assert.match(flow, /^flowchart TD/);
  const graph = flowGraph(flow);
  assert.ok(graph.nodes.length >= 3 && graph.nodes.length <= 12, "Node count within bounds");
  assert.ok(graph.edges.length > 0, "Contains connected edges");
});

test("MANDATORY_FLOW_RULE is injected in WORKFLOW_INSTRUCTIONS", () => {
  assert.ok(WORKFLOW_INSTRUCTIONS.includes(MANDATORY_FLOW_RULE));
  assert.match(WORKFLOW_INSTRUCTIONS, /Mandatory Mermaid Flow Design Gate/);
});

test("normalizeBuildState auto-detects buildHost from SSH commands", () => {
  const result = normalizeBuildState({
    status: "building",
    target: "Paratest Suite",
    command: "ssh -o BatchMode=yes docker-alma vendor/bin/paratest",
  });
  assert.equal(result.buildHost, "docker-alma");
});

test("normalizeBuildState auto-detects buildHost from gcloud compute ssh", () => {
  const result = normalizeBuildState({
    status: "building",
    target: "GCP Cloud Build",
    command: "gcloud compute ssh bw-server-clean --command 'npm run build'",
  });
  assert.equal(result.buildHost, "bw-server-clean");
});

test("normalizeBuildState falls back to machine when command is local without SSH", () => {
  const result = normalizeBuildState({
    status: "building",
    target: "Local Vite Bundle",
    command: "npm run build",
    machine: "HELLOWORLD",
  });
  assert.equal(result.buildHost, "HELLOWORLD");
});

test("dashboard.cjs renders Mesin Builder with Remote VM and Local badge tags", () => {
  const dashboardSource = readFileSync(path.join(ROOT, "monitor-server/dashboard.cjs"), "utf8");
  assert.match(dashboardSource, /Mesin Builder:/);
  assert.match(dashboardSource, /Remote VM/);
  assert.match(dashboardSource, /Lokal/);
});

test("checkpoint rollout documentation exists and records all three devices", () => {
  const doc = readFileSync(path.join(ROOT, "docs/checkpoints/2026-11-06-mandatory-flow-gate-and-multi-device-rollout.md"), "utf8");
  assert.match(doc, /HELLOWORLD/);
  assert.match(doc, /Mac/);
  assert.match(doc, /MMCH/);
  assert.match(doc, /4f5e1f4253c8/);
});
