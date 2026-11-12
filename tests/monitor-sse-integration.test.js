import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEventsStreamManager } = require("../monitor-server/mobile-events-stream.cjs");

describe("Monitor SSE & Snapshot Endpoints Integration", () => {
  test("serves snapshot with cursorId and streams SSE events to connected client", async () => {
    const streamMgr = createEventsStreamManager({ heartbeatMs: 200 });

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");

      if (url.pathname === "/api/v1/mobile/snapshot") {
        res.setHeader("access-control-allow-origin", "*");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            ok: true,
            cursorId: streamMgr.getLatestCursorId(),
            now: new Date().toISOString(),
            sessions: [{ sessionKey: "ses_1", phase: "coding" }],
            events: [],
          })
        );
      }

      if (url.pathname === "/api/v1/mobile/events") {
        res.setHeader("access-control-allow-origin", "*");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          return res.end();
        }
        const lastEventId = req.headers["last-event-id"] || url.searchParams.get("lastEventId");
        return streamMgr.registerClient({ req, res, lastEventId });
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Test Snapshot
      const snapRes = await fetch(`${baseUrl}/api/v1/mobile/snapshot`);
      assert.equal(snapRes.status, 200);
      assert.equal(snapRes.headers.get("access-control-allow-origin"), "*");
      const snapData = await snapRes.json();
      assert.equal(snapData.ok, true);
      assert.equal(snapData.cursorId, 0);
      assert.equal(snapData.sessions.length, 1);

      // 2. Test SSE connection and streaming
      const controller = new AbortController();
      const sseRes = await fetch(`${baseUrl}/api/v1/mobile/events`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      assert.equal(sseRes.status, 200);
      assert.match(sseRes.headers.get("content-type"), /text\/event-stream/);

      // Reader for the stream
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();

      // Read initial connection comment
      const { value: chunk1 } = await reader.read();
      const text1 = decoder.decode(chunk1);
      assert.ok(text1.includes("connected cursor="));

      // 3. Broadcast an event from server and verify client receives it
      streamMgr.broadcast({
        event: "session_update",
        data: { sessionKey: "ses_1", phase: "testing", progress: 80 },
      });

      const { value: chunk2 } = await reader.read();
      const text2 = decoder.decode(chunk2);
      assert.ok(text2.includes("event: session_update"));
      assert.ok(text2.includes('"phase":"testing"'));
      assert.ok(text2.includes("id: 1"));

      controller.abort();
    } finally {
      streamMgr.closeAll();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
