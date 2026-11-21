/**
 * One bounded HTTP GET for the site audit.
 *
 * Every limit in this file exists because an audit walks a site the operator
 * does not control: a hostile page can stream forever, redirect in a loop, or
 * answer with a 2 GB body. The audit must still finish and report what it saw.
 */

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;
export const AUDIT_USER_AGENT =
  "dev-workflow-site-audit/1.0 (+https://devworkflow.programinglive.com)";

const SENSITIVE_QUERY = /^(?:token|key|api[_-]?key|secret|password|passwd|auth|access[_-]?token)$/i;

export function validateAuditUrl(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("A url is required.");
  }

  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`Invalid url: ${input}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https urls are supported, received ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Urls with credentials are not allowed.");
  }

  return parsed;
}

export function redactUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return String(input);
  }

  let changed = false;
  for (const name of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY.test(name)) {
      parsed.searchParams.set(name, "REDACTED");
      changed = true;
    }
  }
  return changed ? parsed.href : input;
}

export function normalizeHeaders(headers) {
  const output = {};
  if (!headers) return output;

  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => {
      output[String(name).toLowerCase()] = String(value);
    });
    return output;
  }

  for (const [name, value] of Object.entries(headers)) {
    output[String(name).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return output;
}

function charsetOf(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType || "");
  return match ? match[1].toLowerCase() : "utf-8";
}

function decodeBody(buffer, charset) {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

async function readBodyCapped(response, maxBodyBytes) {
  if (!response.body) {
    return { buffer: Buffer.alloc(0), bytes: 0, truncated: false };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = Buffer.from(value);
    if (total + chunk.byteLength > maxBodyBytes) {
      const remaining = maxBodyBytes - total;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      total = maxBodyBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }

    chunks.push(chunk);
    total += chunk.byteLength;
  }

  return { buffer: Buffer.concat(chunks), bytes: total, truncated };
}

function failedPage(requestedUrl, error) {
  return {
    requestedUrl,
    finalUrl: requestedUrl,
    status: 0,
    ok: false,
    headers: {},
    contentType: "",
    charset: "utf-8",
    body: "",
    buffer: null,
    bytes: 0,
    truncated: false,
    redirects: [],
    ttfbMs: 0,
    durationMs: 0,
    error,
  };
}

/**
 * @param {string} url
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   maxBodyBytes?: number,
 *   maxRedirects?: number,
 *   method?: string,
 *   readBody?: boolean,
 *   asBuffer?: boolean,
 *   userAgent?: string
 * }} options
 */
export async function fetchPage(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    method = "GET",
    readBody = true,
    asBuffer = false,
    userAgent = AUDIT_USER_AGENT,
  } = options;

  const requestedUrl = validateAuditUrl(url).href;
  const startedAt = Date.now();
  const redirects = [];
  let current = new URL(requestedUrl);
  let response = null;
  let timer = null;

  for (let hop = 0; ; hop += 1) {
    if (hop > maxRedirects) {
      return failedPage(requestedUrl, `Too many redirects (limit ${maxRedirects}).`);
    }

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    let attempt;
    try {
      attempt = await fetchImpl(current.href, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
    } catch (error) {
      clearTimeout(timer);
      const message = error?.name === "AbortError"
        ? `Request timed out after ${timeoutMs} ms.`
        : String(error?.message || error);
      return failedPage(requestedUrl, message);
    }

    const location = attempt.headers.get("location");
    if (attempt.status >= 300 && attempt.status < 400 && location) {
      clearTimeout(timer);
      redirects.push({ url: current.href, status: attempt.status, location });
      if (readBody) await attempt.body?.cancel().catch(() => {});
      let next;
      try {
        next = new URL(location, current);
      } catch {
        return failedPage(requestedUrl, `Invalid redirect location: ${location}`);
      }
      current = validateAuditUrl(next.href);
      continue;
    }

    response = attempt;
    // The timer stays armed: the budget covers the body, not only the headers.
    break;
  }

  const ttfbMs = Date.now() - startedAt;
  const headers = normalizeHeaders(response.headers);
  const contentType = headers["content-type"] || "";

  let body = "";
  let bytes = 0;
  let truncated = false;
  let buffer = null;

  if (readBody) {
    try {
      const capped = await readBodyCapped(response, maxBodyBytes);
      bytes = capped.bytes;
      truncated = capped.truncated;
      buffer = capped.buffer;
      body = asBuffer ? "" : decodeBody(capped.buffer, charsetOf(contentType));
    } catch (error) {
      const message = error?.name === "AbortError"
        ? `Request timed out after ${timeoutMs} ms while reading the body.`
        : String(error?.message || error);
      return failedPage(requestedUrl, message);
    } finally {
      clearTimeout(timer);
    }
  } else {
    clearTimeout(timer);
    await response.body?.cancel().catch(() => {});
  }

  return {
    requestedUrl,
    finalUrl: current.href,
    status: response.status,
    ok: response.ok,
    headers,
    contentType,
    charset: charsetOf(contentType),
    body,
    buffer,
    bytes,
    truncated,
    redirects,
    ttfbMs,
    durationMs: Date.now() - startedAt,
    error: null,
  };
}
