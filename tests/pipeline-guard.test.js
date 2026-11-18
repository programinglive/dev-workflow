import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRemoteProvider,
  checkActivePipelinesBeforeRelease,
} from "../tools/pipeline-guard.js";

test("parseRemoteProvider parses GitLab and GitHub SSH/HTTPS remotes", () => {
  assert.deepEqual(
    parseRemoteProvider("git@gitlab.com:beautyworld_repository/clinic.git"),
    { provider: "gitlab", slug: "beautyworld_repository/clinic" }
  );
  assert.deepEqual(
    parseRemoteProvider("https://gitlab.com/beautyworld_repository/clinic.git"),
    { provider: "gitlab", slug: "beautyworld_repository/clinic" }
  );
  assert.deepEqual(
    parseRemoteProvider("https://github.com/programinglive/dev-workflow-mcp-server.git"),
    { provider: "github", slug: "programinglive/dev-workflow-mcp-server" }
  );
  assert.equal(parseRemoteProvider(""), null);
});

test("checkActivePipelinesBeforeRelease blocks when GitLab has a running or pending pipeline", () => {
  const execStub = (cmd, args) => {
    if (cmd === "git") return "git@gitlab.com:beautyworld_repository/clinic.git";
    if (cmd === "glab") {
      return JSON.stringify([
        { id: 3082240668, status: "running", ref: "v5.1.57", web_url: "https://gitlab.com/p/1" },
        { id: 3082240000, status: "success", ref: "v5.1.56", web_url: "https://gitlab.com/p/0" },
      ]);
    }
    throw new Error(`Unexpected cmd: ${cmd} ${args.join(" ")}`);
  };

  const res = checkActivePipelinesBeforeRelease({
    projectDir: "/tmp/clinic",
    execFileSyncFn: execStub,
  });

  assert.equal(res.ok, false);
  assert.equal(res.provider, "gitlab");
  assert.equal(res.active.length, 1);
  assert.equal(res.active[0].id, 3082240668);
  assert.match(res.message, /3082240668/);
  assert.match(res.message, /running/);
});

test("checkActivePipelinesBeforeRelease allows release when GitLab has no active pipelines", () => {
  const execStub = (cmd) => {
    if (cmd === "git") return "git@gitlab.com:beautyworld_repository/clinic.git";
    if (cmd === "glab") {
      return JSON.stringify([
        { id: 3082240000, status: "success", ref: "v5.1.56", web_url: "https://gitlab.com/p/0" },
      ]);
    }
    throw new Error(`Unexpected cmd: ${cmd}`);
  };

  const res = checkActivePipelinesBeforeRelease({
    projectDir: "/tmp/clinic",
    execFileSyncFn: execStub,
  });

  assert.equal(res.ok, true);
  assert.equal(res.skipped, false);
  assert.deepEqual(res.active, []);
});

test("checkActivePipelinesBeforeRelease blocks when GitHub has an in_progress or queued run", () => {
  const execStub = (cmd) => {
    if (cmd === "git") return "https://github.com/programinglive/dev-workflow-mcp-server.git";
    if (cmd === "gh") {
      return JSON.stringify([
        { databaseId: 9911, status: "in_progress", headBranch: "main", displayTitle: "CI", url: "https://github.com/r/1" },
      ]);
    }
    throw new Error(`Unexpected cmd: ${cmd}`);
  };

  const res = checkActivePipelinesBeforeRelease({
    projectDir: "/tmp/devwf",
    execFileSyncFn: execStub,
  });

  assert.equal(res.ok, false);
  assert.equal(res.provider, "github");
  assert.equal(res.active.length, 1);
  assert.match(res.message, /9911/);
});

test("checkActivePipelinesBeforeRelease skips gracefully when CLI is unavailable", () => {
  const execStub = (cmd) => {
    if (cmd === "git") return "git@gitlab.com:beautyworld_repository/clinic.git";
    const err = new Error("spawnSync glab ENOENT");
    err.code = "ENOENT";
    throw err;
  };

  const res = checkActivePipelinesBeforeRelease({
    projectDir: "/tmp/clinic",
    execFileSyncFn: execStub,
  });

  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
});
