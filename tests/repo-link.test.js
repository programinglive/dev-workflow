/**
 * The monitor card must offer a link straight to the repository.
 *
 * MEASURED GAP (8 November 2026)
 * ------------------------------
 * `repo_path` and `repo_remote` were already captured by the client, stored in
 * the `sessions` table and returned by `/api/sessions`, but the dashboard never
 * rendered them. The card showed the project name only, so the owner still had
 * to find the repository by hand.
 *
 * The link is derived on the SERVER so every client (dashboard, tablet, share
 * page) receives the same answer, and so the conversion is covered by a test
 * instead of living as an untested string replace inside the page script.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { repoLinkFromRemote, withRepoLink } = require("../monitor-server/repo-link.cjs");

test("an scp-style GitHub remote becomes a browsable https link", () => {
  assert.deepEqual(repoLinkFromRemote("git@github.com:programinglive/dev-workflow-mcp-server.git"), {
    url: "https://github.com/programinglive/dev-workflow-mcp-server",
    label: "programinglive/dev-workflow-mcp-server",
  });
});

test("an https remote drops the .git suffix", () => {
  assert.deepEqual(repoLinkFromRemote("https://github.com/programinglive/clinic.git"), {
    url: "https://github.com/programinglive/clinic",
    label: "programinglive/clinic",
  });
});

test("an ssh:// remote keeps the path and nested groups", () => {
  assert.deepEqual(repoLinkFromRemote("ssh://git@gitlab.com/programinglive/infra/repo.git"), {
    url: "https://gitlab.com/programinglive/infra/repo",
    label: "programinglive/infra/repo",
  });
});

test("credentials are stripped from the link and never shown", () => {
  assert.deepEqual(repoLinkFromRemote("https://user:secret@github.com/org/repo.git"), {
    url: "https://github.com/org/repo",
    label: "org/repo",
  });
});

test("a trailing slash and surrounding space are ignored", () => {
  assert.deepEqual(repoLinkFromRemote("  https://github.com/org/repo/  "), {
    url: "https://github.com/org/repo",
    label: "org/repo",
  });
});

test("a non-web scheme is refused instead of rendered as a link", () => {
  assert.equal(repoLinkFromRemote("javascript:alert(1)"), null);
  assert.equal(repoLinkFromRemote("file:///C:/secret"), null);
});

test("an empty or unknown remote produces no link", () => {
  assert.equal(repoLinkFromRemote(""), null);
  assert.equal(repoLinkFromRemote("   "), null);
  assert.equal(repoLinkFromRemote("not a remote"), null);
  assert.equal(repoLinkFromRemote(null), null);
});

test("a session row gains repo_url and repo_label from its remote", () => {
  const row = withRepoLink({
    session_key: "ses_1",
    repo_path: "C:/code/clinic",
    repo_remote: "git@github.com:programinglive/clinic.git",
  });
  assert.equal(row.repo_url, "https://github.com/programinglive/clinic");
  assert.equal(row.repo_label, "programinglive/clinic");
});

test("a row without a remote keeps the repository path but has no link", () => {
  const row = withRepoLink({ repo_path: "C:/code/local-only", repo_remote: "" });
  assert.equal(row.repo_url, "");
  assert.equal(row.repo_label, "");
  assert.equal(row.repo_path, "C:/code/local-only");
});

test("the dashboard card and modal both render the repository link", () => {
  const source = fs.readFileSync(new URL("../monitor-server/dashboard.cjs", import.meta.url), "utf8");
  assert.match(source, /repoLinkHtml\(/, "the page must have one helper that renders the link");
  assert.match(source, /class="repo-link"/, "the link must carry a stable class for styling");
  assert.match(source, /rel="noopener noreferrer"/, "an external link must not get a window handle");
  assert.match(source, /target="_blank"/);
  // The card and the modal must both call the helper.
  const calls = source.match(/repoLinkHtml\(/g) || [];
  assert.ok(calls.length >= 3, `expected the helper definition plus card and modal usage, saw ${calls.length}`);
});