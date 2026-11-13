import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseSSEChunk,
  ConnectionManager,
} from "./connection-manager.js";

describe("mobile-app connection-manager", () => {
  describe("parseSSEChunk", () => {
    test("parses single complete SSE message", () => {
      const raw = 'id: 42\nevent: session_update\ndata: {"sessionKey":"s1"}\n\n';
      const { messages, remainder } = parseSSEChunk(raw);

      assert.equal(messages.length, 1);
      assert.equal(messages[0].id, "42");
      assert.equal(messages[0].event, "session_update");
      assert.deepEqual(messages[0].data, { sessionKey: "s1" });
      assert.equal(remainder, "");
    });

    test("handles partial/split chunks across packets", () => {
      const part1 = "id: 5\nevent: heartbeat\ndata: 123";
      const { messages: m1, remainder: r1 } = parseSSEChunk(part1);
      assert.equal(m1.length, 0);
      assert.equal(r1, part1);

      const part2 = "\n\n";
      const { messages: m2, remainder: r2 } = parseSSEChunk(r1 + part2);
      assert.equal(m2.length, 1);
      assert.equal(m2[0].id, "5");
      assert.equal(r2, "");
    });

    test("parses comment / heartbeat lines without throwing", () => {
      const raw = ": heartbeat 2026-11-12T12:00:00Z\n\n";
      const { messages } = parseSSEChunk(raw);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].isComment, true);
      assert.equal(messages[0].comment, "heartbeat 2026-11-12T12:00:00Z");
    });
  });

  describe("ConnectionManager lifecycle", () => {
    test("fetches initial snapshot and updates status to LIVE on stream connect", async () => {
      let currentStatus = null;
      let lastData = null;

      const fakeFetch = async (url) => {
        if (url.includes("/api/v1/mobile/snapshot")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              cursorId: 10,
              sessions: [{ sessionKey: "ses_1", phase: "coding" }],
            }),
          };
        }
        if (url.includes("/api/v1/mobile/events")) {
          // Return a stream that emits one message then stays open
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(': connected\n\nid: 11\nevent: session_update\ndata: {"sessionKey":"ses_1","phase":"testing"}\n\n'));
            },
          });
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "text/event-stream" }),
            body: stream,
          };
        }
        throw new Error(`Unhandled url: ${url}`);
      };

      const cm = new ConnectionManager({
        getBaseUrl: () => "http://127.0.0.1:3100",
        onStatusChange: (s) => { currentStatus = s; },
        onData: (d) => { lastData = d; },
        fetchFn: fakeFetch,
        pollIntervalMs: 50,
        maxSseRetriesBeforeFallback: 3,
      });

      await cm.start();

      assert.equal(currentStatus, "LIVE");
      assert.ok(lastData);
      assert.equal(cm.getCursorId(), 11);

      cm.stop();
      assert.equal(currentStatus, "OFFLINE");
    });

    test("falls back to POLLING when SSE fails 3 consecutive times", async () => {
      let currentStatus = null;
      let pollCount = 0;

      const fakeFetch = async (url) => {
        if (url.includes("/api/v1/mobile/snapshot")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, cursorId: 5, sessions: [] }),
          };
        }
        if (url.includes("/api/v1/mobile/events")) {
          // SSE fails immediately (e.g. proxy blocks or 404)
          throw new Error("SSE connection failed");
        }
        if (url.includes("/api/sessions")) {
          pollCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ sessions: [], now: new Date().toISOString() }),
          };
        }
        throw new Error(`Unhandled url: ${url}`);
      };

      const cm = new ConnectionManager({
        getBaseUrl: () => "http://127.0.0.1:3100",
        onStatusChange: (s) => { currentStatus = s; },
        fetchFn: fakeFetch,
        backoffBaseMs: 5,
        pollIntervalMs: 20,
        maxSseRetriesBeforeFallback: 3,
      });

      await cm.start();

      // Wait for 3 retries and fallback to POLLING
      for (let i = 0; i < 20; i++) {
        if (currentStatus === "POLLING") break;
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.equal(currentStatus, "POLLING");
      assert.ok(pollCount > 0, "Polling endpoint must be called in POLLING mode");

      cm.stop();
      assert.equal(currentStatus, "OFFLINE");
    });
  });
});
