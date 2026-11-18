import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTags, ensureTags } from "../zettly-tags.js";

/**
 * Owner instruction, 10 November 2026: every Zettly Todo must carry tags,
 * because the zettelkasten method depends on being able to walk relations —
 * "when we need something, we immediately know what is connected".
 *
 * The scheme is four axes, so a card can be found from several directions:
 *   proyek:<name>   which codebase
 *   tipe:<type>     feature / bugfix / refactor / infra / other
 *   area:<topic>    subsystem, inferred from the wording and the path
 *   sumber:<from>   manual, sentry
 */

test("a task yields a project tag from the repository name", () => {
  const tags = deriveTags({
    taskDescription: "Fix the monitor dedupe",
    taskType: "bugfix",
    projectDir: "/Users/mahardhika/code/dev-workflow-mcp-server",
  });
  assert.ok(tags.includes("proyek:dev-workflow-mcp-server"), tags.join(", "));
});

test("a task yields a type tag", () => {
  const tags = deriveTags({ taskDescription: "x", taskType: "bugfix", projectDir: "/code/app" });
  assert.ok(tags.includes("tipe:bugfix"));
});

test("an unknown task type still yields a stable type tag", () => {
  const tags = deriveTags({ taskDescription: "x", taskType: "", projectDir: "/code/app" });
  assert.ok(tags.includes("tipe:other"));
});

test("an area tag is inferred from the wording", () => {
  const tags = deriveTags({
    taskDescription: "Fix the mermaid flow on monitor cards",
    taskType: "bugfix",
    projectDir: "/code/dev-workflow-mcp-server",
  });
  assert.ok(tags.includes("area:monitor"), tags.join(", "));
});

test("the source tag defaults to manual", () => {
  const tags = deriveTags({ taskDescription: "x", taskType: "feature", projectDir: "/code/app" });
  assert.ok(tags.includes("sumber:manual"));
});

test("a Sentry-sourced task carries the sentry source tag", () => {
  const tags = deriveTags({
    taskDescription: "x",
    taskType: "bugfix",
    projectDir: "/code/app",
    taskOrigin: { system: "sentry", id: "ERP-49" },
  });
  assert.ok(tags.includes("sumber:sentry"));
});

test("tags are bounded, de-duplicated and never empty", () => {
  const tags = deriveTags({
    taskDescription: "monitor monitor monitor",
    taskType: "bugfix",
    projectDir: "/code/dev-workflow-mcp-server",
  });
  assert.equal(new Set(tags).size, tags.length, "no duplicate tags");
  assert.ok(tags.length >= 3 && tags.length <= 8, `bounded, got ${tags.length}`);
  for (const tag of tags) {
    assert.match(tag, /^(proyek|tipe|area|sumber):[a-z0-9._-]+$/, `unexpected tag shape: ${tag}`);
  }
});

test("a Chinese or spaced task name cannot produce an invalid tag", () => {
  const tags = deriveTags({
    taskDescription: "Perbaiki tampilan kartu di Mac — sangat penting!",
    taskType: "bugfix",
    projectDir: "/code/My Project (v2)",
  });
  for (const tag of tags) {
    assert.match(tag, /^(proyek|tipe|area|sumber):[a-z0-9._-]+$/, `unexpected tag shape: ${tag}`);
  }
});

test("ensureTags reuses an existing tag instead of creating a duplicate", async () => {
  const calls = [];
  const client = {
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (method === "GET" && route === "/tags") {
        // The production shape: top-level `tags`, no `data` wrapper.
        return { tags: [{ id: 7, name: "proyek:app" }, { id: 9, name: "tipe:bugfix" }], deletedTags: [] };
      }
      return { data: { tag: { id: 99, name: "area:monitor" } } };
    },
  };

  const ids = await ensureTags({ client, names: ["proyek:app", "tipe:bugfix", "area:monitor"] });

  assert.deepEqual(ids, [7, 9, 99]);
  const created = calls.filter((call) => call.method === "POST");
  assert.equal(created.length, 1, "only the unknown tag is created");
  assert.equal(created[0].body.name, "area:monitor");
});

test("a data-wrapped tag list is also understood", async () => {
  const client = {
    async request(method) {
      if (method === "GET") return { data: { tags: [{ id: 3, name: "tipe:feature" }] } };
      return {};
    },
  };
  const ids = await ensureTags({ client, names: ["tipe:feature"] });
  assert.deepEqual(ids, [3]);
});

test("a tag that already exists (409) is resolved from a re-read instead of dropped", async () => {
  let listReads = 0;
  const client = {
    async request(method, route) {
      if (method === "GET" && route === "/tags") {
        listReads += 1;
        // First read is stale; the tag appears on the re-read after the 409.
        return listReads === 1
          ? { tags: [] }
          : { tags: [{ id: 12, name: "area:zettly" }] };
      }
      throw Object.assign(new Error("Zettly HTTP 409"), { status: 409 });
    },
  };
  const ids = await ensureTags({ client, names: ["area:zettly"] });
  assert.deepEqual(ids, [12]);
});

test("a tag failure never throws, it returns what it could resolve", async () => {
  const client = {
    async request() {
      throw new Error("Zettly HTTP 500");
    },
  };
  const ids = await ensureTags({ client, names: ["proyek:app"] });
  assert.deepEqual(ids, []);
});
