// @ts-check
'use strict';

/**
 * Formats a Server-Sent Events (SSE) message or comment block.
 *
 * @param {{
 *   id?: number | string,
 *   event?: string,
 *   data?: any,
 *   comment?: string
 * }} options
 * @returns {string}
 */
function formatSSEMessage({ id, event, data, comment }) {
  if (comment !== undefined && comment !== null) {
    return `: ${comment}\n\n`;
  }

  let out = '';
  if (id !== undefined && id !== null) {
    out += `id: ${id}\n`;
  }
  if (event) {
    out += `event: ${event}\n`;
  }
  if (data !== undefined) {
    out += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n`;
  }
  return out + '\n';
}

/**
 * Creates an in-memory Server-Sent Events manager with cursor sequencing,
 * bounded ring buffer for reconnection replay, and client management.
 *
 * @param {{
 *   maxBufferSize?: number,
 *   heartbeatMs?: number
 * }} [config]
 */
function createEventsStreamManager({ maxBufferSize = 200, heartbeatMs = 15000 } = {}) {
  let nextCursorId = 1;
  const eventsBuffer = [];
  const activeClients = new Set();

  /**
   * Broadcasts an event to all connected clients and appends to the buffer.
   *
   * @param {{ event: string, data: any }} param
   * @returns {{ id: number, event: string, data: any, timestamp: number }}
   */
  function broadcast({ event, data }) {
    const id = nextCursorId++;
    const item = {
      id,
      event,
      data,
      timestamp: Date.now(),
    };

    eventsBuffer.push(item);
    while (eventsBuffer.length > maxBufferSize) {
      eventsBuffer.shift();
    }

    const sseChunk = formatSSEMessage(item);
    for (const client of activeClients) {
      try {
        client.res.write(sseChunk);
      } catch (err) {
        // Client write failed; remove on error
        clearInterval(client.timer);
        activeClients.delete(client);
      }
    }

    return item;
  }

  /**
   * Returns the most recent cursor ID issued.
   */
  function getLatestCursorId() {
    return nextCursorId - 1;
  }

  /**
   * Returns current buffer size.
   */
  function getBufferSize() {
    return eventsBuffer.length;
  }

  /**
   * Returns all buffered events strictly after lastId.
   *
   * @param {number} lastId
   */
  function getEventsSince(lastId) {
    const num = Number(lastId);
    if (!Number.isFinite(num)) return [];
    return eventsBuffer.filter((e) => e.id > num);
  }

  /**
   * Checks whether a client's requested cursor has already been purged from the buffer.
   *
   * @param {number} requestedId
   */
  function checkCursorStatus(requestedId) {
    if (eventsBuffer.length === 0) {
      return { isStale: false, minAvailableId: null };
    }
    const minAvailableId = eventsBuffer[0].id;
    const num = Number(requestedId);
    const isStale = Number.isFinite(num) && num < minAvailableId;
    return { isStale, minAvailableId };
  }

  /**
   * Registers a new HTTP connection for SSE streaming.
   *
   * @param {{
   *   req: any,
   *   res: any,
   *   lastEventId?: number | string | null
   * }} params
   */
  function registerClient({ req, res, lastEventId = null }) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization, last-event-id',
    });

    // Replay missed events if client reconnected with a valid cursor
    if (lastEventId !== null && lastEventId !== undefined && lastEventId !== '') {
      const missed = getEventsSince(Number(lastEventId));
      for (const ev of missed) {
        res.write(formatSSEMessage(ev));
      }
    }

    // Initial connection comment
    res.write(formatSSEMessage({ comment: `connected cursor=${getLatestCursorId()}` }));

    // Heartbeat timer
    const timer = setInterval(() => {
      try {
        res.write(formatSSEMessage({ comment: `heartbeat ${new Date().toISOString()}` }));
      } catch {
        clearInterval(timer);
        activeClients.delete(clientHandle);
      }
    }, heartbeatMs);

    const clientHandle = { req, res, timer };
    activeClients.add(clientHandle);

    req.on('close', () => {
      clearInterval(timer);
      activeClients.delete(clientHandle);
    });

    return clientHandle;
  }

  /**
   * Returns count of active SSE subscribers.
   */
  function getClientCount() {
    return activeClients.size;
  }

  /**
   * Closes all active client connections (used in test tear-down or server shutdown).
   */
  function closeAll() {
    for (const client of activeClients) {
      clearInterval(client.timer);
      try {
        client.res.end();
      } catch {}
    }
    activeClients.clear();
  }

  return {
    broadcast,
    getLatestCursorId,
    getBufferSize,
    getEventsSince,
    checkCursorStatus,
    registerClient,
    getClientCount,
    closeAll,
  };
}

module.exports = {
  formatSSEMessage,
  createEventsStreamManager,
};
