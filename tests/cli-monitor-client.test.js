import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitorClient } from "../cli/monitor-client.js";
import { CliError } from "../cli/args.js";

const ENV = { DEVWF_MONITOR_URL: "http://monitor.test", DEVWF_MONITOR_TOKEN: "secret-token" };

/** A fetch stub that records calls and answers with a canned response. */
function fakeFetch({ status = 200, body = { ok: true } } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body);
      },
    };
  };
  return { impl, calls };
}

test("a missing monitor URL is refused and the message names the variable", () => {
  assert.throws(
    () => createMonitorClient({ env: { DEVWF_MONITOR_TOKEN: "t" }, fetchImpl: fakeFetch().impl }),
    (error) => error instanceof CliError && /DEVWF_MONITOR_URL/.test(error.message)
  );
});

test("a missing token is refused and the message names the variable", () => {
  assert.throws(
    () => createMonitorClient({ env: { DEVWF_MONITOR_URL: "http://m" }, fetchImpl: fakeFetch().impl }),
    (error) => error instanceof CliError && /DEVWF_MONITOR_TOKEN/.test(error.message)
  );
});

test("closeSession posts the session key to the close endpoint with a bearer token", async () => {
  const fake = fakeFetch({ body: { ok: true, closed: true } });
  const monitor = createMonitorClient({ env: ENV, fetchImpl: fake.impl });

  const result = await monitor.closeSession({ sessionKey: "ses_abc" });

  assert.equal(result.closed, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, "http://monitor.test/api/session/close");
  assert.equal(fake.calls[0].init.method, "POST");
  assert.equal(fake.calls[0].init.headers.authorization, "Bearer secret-token");
  assert.equal(JSON.parse(fake.calls[0].init.body).sessionKey, "ses_abc");
});

test("revokeShare deletes one token by query parameter, url-encoded", async () => {
  const fake = fakeFetch({ body: { ok: true, revoked: true } });
  const monitor = createMonitorClient({ env: ENV, fetchImpl: fake.impl });

  await monitor.revokeShare({ token: "a b/c" });

  assert.equal(fake.calls[0].init.method, "DELETE");
  assert.match(fake.calls[0].url, /\/api\/share\?token=a%20b%2Fc$/);
});

test("revokeOrphans posts the revoke-orphans switch", async () => {
  const fake = fakeFetch({ body: { ok: true } });
  const monitor = createMonitorClient({ env: ENV, fetchImpl: fake.impl });

  await monitor.revokeOrphans();

  assert.equal(fake.calls[0].init.method, "POST");
  assert.match(fake.calls[0].url, /\/api\/share\?revoke-orphans=1$/);
});

test("listShares reads every live link", async () => {
  const fake = fakeFetch({ body: { ok: true, links: [] } });
  const monitor = createMonitorClient({ env: ENV, fetchImpl: fake.impl });

  const result = await monitor.listShares();

  assert.deepEqual(result.links, []);
  assert.match(fake.calls[0].url, /\/api\/share\?all=1$/);
});

test("listSessions reads the session list without a write token in the body", async () => {
  const fake = fakeFetch({ body: { ok: true, sessions: [] } });
  const monitor = createMonitorClient({ env: ENV, fetchImpl: fake.impl });

  const result = await monitor.listSessions();

  assert.deepEqual(result.sessions, []);
  assert.match(fake.calls[0].url, /\/api\/sessions$/);
});

test("a non-2xx answer becomes a CliError carrying the status and server text", async () => {
  const fake = fakeFetch({ status: 403, body: { ok: false, error: "forbidden" } });
  const monitor = createMonitorClient({ env: ENV, fetchImpl: fake.impl });

  await assert.rejects(
    () => monitor.closeSession({ sessionKey: "ses_abc" }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("403") &&
      /forbidden/.test(error.message)
  );
});

test("the token never appears in a thrown error message", async () => {
  const fake = fakeFetch({ status: 500, body: { ok: false, error: "boom" } });
  const monitor = createMonitorClient({ env: ENV, fetchImpl: fake.impl });

  await assert.rejects(
    () => monitor.closeSession({ sessionKey: "ses_abc" }),
    (error) => !error.message.includes("secret-token")
  );
});

test("a trailing slash in the base URL does not produce a double slash", async () => {
  const fake = fakeFetch({ body: { ok: true } });
  const monitor = createMonitorClient({
    env: { ...ENV, DEVWF_MONITOR_URL: "http://monitor.test/" },
    fetchImpl: fake.impl,
  });

  await monitor.listSessions();

  assert.equal(fake.calls[0].url, "http://monitor.test/api/sessions");
});
