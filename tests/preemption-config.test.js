import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSentryPreemption,
  isPreemptionProjectDir,
  resolvePreemptionConfig,
} from "../tools/handler-modules/integration-handlers.js";

function text(r) {
  return r?.content?.[0]?.text || "";
}

const BASE_ENV = {
  DEVWF_PREEMPTION_ENABLED: "1",
  DEVWF_PREEMPTION_SENTRY_PROJECT: "payments",
  DEVWF_PREEMPTION_QUERY: "is:unresolved project:payments",
  DEVWF_PREEMPTION_PROJECT_DIR_MARKERS: "/work/payments-service",
};

function sentryStub(issues = [], fail = false) {
  return {
    organization: "example-org",
    calls: 0,
    async listIssues() {
      this.calls += 1;
      if (fail) throw new Error("sentry unavailable");
      return issues;
    },
  };
}

test("preemption is disabled by default and never calls Sentry", async () => {
  const sentry = sentryStub([{ id: "1", shortId: "APP-1", title: "boom" }]);
  const result = await checkSentryPreemption({
    projectDir: "D:\\work\\other-service",
    mode: "start_task",
    options: { env: {}, sentry },
  });
  assert.equal(result.preempted, false);
  assert.equal(result.response, null);
  assert.equal(sentry.calls, 0);
});

test("configured preemption blocks a matching unresolved issue and exempts the marked directory", async () => {
  const issues = [{ id: "1", shortId: "APP-1", title: "boom", project: { slug: "payments" } }];
  const options = { env: BASE_ENV, sentry: sentryStub(issues) };
  const blocked = await checkSentryPreemption({
    projectDir: "D:\\work\\other-service",
    mode: "start_task",
    options,
  });
  assert.equal(blocked.preempted, true);
  assert.equal(blocked.response.isError, true);
  assert.match(text(blocked.response), /SENTRY PREEMPTION GATE/);
  assert.match(text(blocked.response), /APP-1/);

  const exempt = await checkSentryPreemption({
    projectDir: "D:\\work\\payments-service",
    mode: "start_task",
    options,
  });
  assert.equal(exempt.preempted, false);
  assert.equal(isPreemptionProjectDir("D:/work/payments-service", resolvePreemptionConfig(BASE_ENV)), true);
});

test("new and deprecated override flags both allow the start, with a deprecation warning on the alias", async () => {
  const options = {
    env: BASE_ENV,
    sentry: sentryStub([{ id: "1", shortId: "APP-1", project: { slug: "payments" } }]),
  };
  const modern = await checkSentryPreemption({
    projectDir: "D:\\work\\other-service",
    allowPreemptionOverride: true,
    mode: "start_task",
    options,
  });
  assert.equal(modern.preempted, false);
  assert.equal(modern.deprecationWarning, undefined);

  const legacy = await checkSentryPreemption({
    projectDir: "D:\\work\\other-service",
    allowPreemptionOverrideAlias: true,
    mode: "start_task",
    options,
  });
  assert.equal(legacy.preempted, false);
  assert.match(legacy.deprecationWarning, /deprecated/i);
});

test("configured gate fails closed when Sentry is unavailable or config is incomplete", async () => {
  const failed = await checkSentryPreemption({
    projectDir: "D:\\work\\other-service",
    mode: "start_task",
    options: { env: BASE_ENV, sentry: sentryStub([], true) },
  });
  assert.equal(failed.preempted, true);
  assert.equal(failed.response.isError, true);

  const incomplete = resolvePreemptionConfig({ ...BASE_ENV, DEVWF_PREEMPTION_QUERY: "" });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reason, /DEVWF_PREEMPTION_QUERY/);
});

test("mid-task alert uses neutral wording and stays warning-only", async () => {
  const alert = await checkSentryPreemption({
    projectDir: "D:\\work\\other-service",
    mode: "status",
    options: {
      env: BASE_ENV,
      sentry: sentryStub([{ id: "1", shortId: "APP-1", project: { slug: "payments" } }]),
    },
  });
  assert.equal(alert.preempted, true);
  assert.equal(alert.response, null);
  assert.match(alert.alertText, /SENTRY PREEMPTION ALERT/);
});
