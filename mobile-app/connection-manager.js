/**
 * Parses raw SSE chunk data into discrete message objects.
 * Handles split packets and buffers partial trailing lines.
 *
 * @param {string} rawChunk
 * @returns {{
 *   messages: Array<{ id?: string, event?: string, data?: any, comment?: string, isComment?: boolean }>,
 *   remainder: string
 * }}
 */
export function parseSSEChunk(rawChunk) {
  if (!rawChunk || typeof rawChunk !== "string") {
    return { messages: [], remainder: "" };
  }

  const normalized = rawChunk.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() || "";
  const messages = [];

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.split("\n");
    let id = null;
    let event = null;
    let dataStr = "";
    let comment = null;
    let isComment = false;

    for (const line of lines) {
      if (line.startsWith(":")) {
        isComment = true;
        comment = line.slice(1).trim();
        continue;
      }
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const val = line.slice(5).trim();
        dataStr = dataStr ? `${dataStr}\n${val}` : val;
      }
    }

    if (isComment) {
      messages.push({ isComment: true, comment });
    } else {
      let data = dataStr;
      try {
        data = JSON.parse(dataStr);
      } catch {
        // Keep raw text if not JSON
      }
      messages.push({
        id: id || undefined,
        event: event || "message",
        data,
      });
    }
  }

  return { messages, remainder };
}

/**
 * Enterprise Connection Manager managing SSE streaming lifecycle, reconnection backoff,
 * cursor synchronization, and seamless fallback to adaptive REST polling.
 */
export class ConnectionManager {
  constructor({
    getBaseUrl,
    getToken = () => null,
    onStatusChange = () => {},
    onData = () => {},
    onError = () => {},
    fetchFn = fetch,
    pollIntervalMs = 3000,
    backoffBaseMs = 1000,
    maxSseRetriesBeforeFallback = 3,
  } = {}) {
    this.getBaseUrl = typeof getBaseUrl === "function" ? getBaseUrl : () => getBaseUrl;
    this.getToken = typeof getToken === "function" ? getToken : () => getToken;
    this.onStatusChange = onStatusChange;
    this.onData = onData;
    this.onError = onError;
    this.fetchFn = fetchFn;
    this.pollIntervalMs = pollIntervalMs;
    this.backoffBaseMs = backoffBaseMs;
    this.maxSseRetriesBeforeFallback = maxSseRetriesBeforeFallback;

    this.status = "OFFLINE";
    this.cursorId = null;
    this.consecutiveErrors = 0;
    this.isRunning = false;
    this.abortController = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.streamReader = null;
  }

  setStatus(nextStatus) {
    if (this.status !== nextStatus) {
      this.status = nextStatus;
      this.onStatusChange(nextStatus);
    }
  }

  getCursorId() {
    return this.cursorId;
  }

  getStatus() {
    return this.status;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.consecutiveErrors = 0;
    await this._connect();
  }

  stop() {
    this.isRunning = false;
    this._teardown();
    this.setStatus("OFFLINE");
  }

  _teardown() {
    if (this.abortController) {
      try { this.abortController.abort(); } catch {}
      this.abortController = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.streamReader) {
      try { this.streamReader.cancel(); } catch {}
      this.streamReader = null;
    }
  }

  async _connect() {
    if (!this.isRunning) return;
    this._teardown();
    this.setStatus("CONNECTING");

    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      this.setStatus("OFFLINE");
      return;
    }

    try {
      // 1. Fetch initial snapshot
      await this._fetchSnapshot(baseUrl);

      // 2. Open SSE stream
      await this._startSSE(baseUrl);
    } catch (err) {
      this._handleFailure(err);
    }
  }

  async _fetchSnapshot(baseUrl) {
    this.abortController = new AbortController();
    const token = this.getToken();
    const headers = { "cache-control": "no-store" };
    if (token) headers["authorization"] = `Bearer ${token}`;

    const snapUrl = `${baseUrl}/api/v1/mobile/snapshot`;
    let res = await this.fetchFn(snapUrl, {
      headers,
      signal: this.abortController.signal,
    }).catch(() => null);

    // If /snapshot not supported yet on older server, fallback to /api/sessions
    if (!res || !res.ok) {
      const fallbackUrl = `${baseUrl}/api/sessions`;
      res = await this.fetchFn(fallbackUrl, {
        headers,
        signal: this.abortController.signal,
      });
    }

    if (!res.ok) throw new Error(`Snapshot fetch failed HTTP ${res.status}`);

    const data = await res.json();
    if (data.cursorId !== undefined) {
      this.cursorId = data.cursorId;
    }
    this.onData(data);
  }

  async _startSSE(baseUrl) {
    if (!this.isRunning) return;

    this.abortController = new AbortController();
    const token = this.getToken();
    const headers = {
      Accept: "text/event-stream",
    };
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (this.cursorId !== null && this.cursorId !== undefined) {
      headers["last-event-id"] = String(this.cursorId);
    }

    const sseUrl = `${baseUrl}/api/v1/mobile/events${this.cursorId ? `?lastEventId=${this.cursorId}` : ""}`;
    const res = await this.fetchFn(sseUrl, {
      headers,
      signal: this.abortController.signal,
    });

    if (!res.ok) throw new Error(`SSE rejected HTTP ${res.status}`);

    const contentType = res.headers ? res.headers.get("content-type") : "";
    if (contentType && !contentType.includes("text/event-stream")) {
      throw new Error(`Invalid SSE content-type: ${contentType}`);
    }

    if (!res.body || typeof res.body.getReader !== "function") {
      throw new Error("Streaming ReadableStream not available in environment");
    }

    this.streamReader = res.body.getReader();
    this.setStatus("LIVE");
    this.consecutiveErrors = 0;

    const decoder = new TextDecoder();
    let streamBuffer = "";

    // Consume stream in background loop without blocking callers
    (async () => {
      try {
        while (this.isRunning && this.streamReader) {
          const { value, done } = await this.streamReader.read();
          if (done) break;

          streamBuffer += decoder.decode(value, { stream: true });
          const { messages, remainder } = parseSSEChunk(streamBuffer);
          streamBuffer = remainder;

          for (const msg of messages) {
            if (msg.isComment) continue;
            if (msg.id) {
              const num = Number(msg.id);
              if (Number.isFinite(num)) this.cursorId = num;
            }
            if (msg.data) {
              this.onData(msg.data);
            }
          }
        }
      } catch (err) {
        if (this.isRunning) {
          this._handleFailure(err);
        }
      }
    })();
  }

  _handleFailure(err) {
    if (!this.isRunning) return;
    this.consecutiveErrors++;
    this.onError(err);

    if (this.consecutiveErrors >= this.maxSseRetriesBeforeFallback) {
      this._startPolling();
    } else {
      this.setStatus("RECONNECTING");
      const delay = Math.min(
        this.backoffBaseMs * (2 ** (this.consecutiveErrors - 1)),
        10000
      );
      this.reconnectTimer = setTimeout(() => {
        if (this.isRunning) this._connect();
      }, delay);
    }
  }

  _startPolling() {
    this._teardown();
    this.setStatus("POLLING");

    const doPoll = async () => {
      if (!this.isRunning || this.status !== "POLLING") return;
      try {
        const baseUrl = this.getBaseUrl();
        if (!baseUrl) return;
        const res = await this.fetchFn(`${baseUrl}/api/sessions`, {
          headers: { "cache-control": "no-store" },
        });
        if (res.ok) {
          const json = await res.json();
          this.onData(json);
        }
      } catch (e) {
        this.onError(e);
      }
    };

    doPoll();
    this.pollTimer = setInterval(doPoll, this.pollIntervalMs);
  }
}
