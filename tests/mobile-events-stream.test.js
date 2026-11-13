import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createEventsStreamManager,
  formatSSEMessage,
} = require("../monitor-server/mobile-events-stream.cjs");

describe("mobile-events-stream domain logic", () => {
  let streamMgr;

  beforeEach(() => {
    streamMgr = createEventsStreamManager({ maxBufferSize: 10, heartbeatMs: 50 });
  });

  afterEach(() => {
    streamMgr.closeAll();
  });

  describe("formatSSEMessage", () => {
    test("formats standard SSE message with id, event, and json data", () => {
      const msg = formatSSEMessage({
        id: 101,
        event: "session_update",
        data: { sessionKey: "ses_1", phase: "coding" },
      });

      assert.equal(
        msg,
        'id: 101\nevent: session_update\ndata: {"sessionKey":"ses_1","phase":"coding"}\n\n'
      );
    });

    test("formats heartbeat comment line", () => {
      const msg = formatSSEMessage({
        comment: "heartbeat 2026-11-12T12:00:00.000Z",
      });

      assert.equal(msg, ": heartbeat 2026-11-12T12:00:00.000Z\n\n");
    });
  });

  describe("Event Buffer & Cursor Tracking", () => {
    test("assigns monotonically increasing cursor ids and buffers events", () => {
      const e1 = streamMgr.broadcast({ event: "session_update", data: { n: 1 } });
      const e2 = streamMgr.broadcast({ event: "session_update", data: { n: 2 } });

      assert.equal(e1.id, 1);
      assert.equal(e2.id, 2);
      assert.equal(streamMgr.getLatestCursorId(), 2);
    });

    test("bounds buffer to maxBufferSize and purges oldest events", () => {
      for (let i = 1; i <= 15; i++) {
        streamMgr.broadcast({ event: "item", data: { i } });
      }

      assert.equal(streamMgr.getBufferSize(), 10);
      assert.equal(streamMgr.getLatestCursorId(), 15);

      // Replaying from cursor 10 should return events 11 to 15 (5 events)
      const replayed = streamMgr.getEventsSince(10);
      assert.equal(replayed.length, 5);
      assert.equal(replayed[0].id, 11);
      assert.equal(replayed[4].id, 15);
    });

    test("detects when requested cursor is too old and purged", () => {
      for (let i = 1; i <= 20; i++) {
        streamMgr.broadcast({ event: "item", data: { i } });
      }

      // Buffer now holds 11..20; cursor 5 has been purged
      const status = streamMgr.checkCursorStatus(5);
      assert.equal(status.isStale, true);
      assert.equal(status.minAvailableId, 11);
    });
  });

  describe("Client Subscription & Streaming", () => {
    test("streams broadcast events to connected HTTP response", async () => {
      const writtenChunks = [];
      const fakeRes = {
        writeHead: (code, headers) => {
          fakeRes.statusCode = code;
          fakeRes.headers = headers;
        },
        write: (chunk) => {
          writtenChunks.push(chunk);
        },
        end: () => {},
      };

      const fakeReq = {
        headers: {},
        on: (ev, handler) => {
          if (ev === "close") fakeReq.closeHandler = handler;
        },
      };

      streamMgr.registerClient({ req: fakeReq, res: fakeRes, lastEventId: null });

      assert.equal(fakeRes.statusCode, 200);
      assert.equal(fakeRes.headers["content-type"], "text/event-stream");
      assert.equal(streamMgr.getClientCount(), 1);

      // Broadcast an event
      streamMgr.broadcast({ event: "test_event", data: { hello: "world" } });

      assert.ok(writtenChunks.some((c) => c.includes("test_event")));
      assert.ok(writtenChunks.some((c) => c.includes('"hello":"world"')));

      // Disconnect
      fakeReq.closeHandler();
      assert.equal(streamMgr.getClientCount(), 0);
    });

    test("replays missed events on initial connection when lastEventId is supplied", () => {
      streamMgr.broadcast({ event: "ev1", data: { a: 1 } }); // id 1
      streamMgr.broadcast({ event: "ev2", data: { a: 2 } }); // id 2
      streamMgr.broadcast({ event: "ev3", data: { a: 3 } }); // id 3

      const writtenChunks = [];
      const fakeRes = {
        writeHead: () => {},
        write: (chunk) => writtenChunks.push(chunk),
        end: () => {},
      };
      const fakeReq = { headers: {}, on: () => {} };

      // Client reconnects claiming lastEventId = 1
      streamMgr.registerClient({ req: fakeReq, res: fakeRes, lastEventId: 1 });

      // Should have replayed id 2 and id 3
      assert.ok(writtenChunks.some((c) => c.includes("id: 2")));
      assert.ok(writtenChunks.some((c) => c.includes("id: 3")));
      assert.ok(!writtenChunks.some((c) => c.includes("id: 1\n")));
    });
  });
});
