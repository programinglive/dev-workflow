/**
 * Security response headers.
 *
 * These findings describe what the response actually sent. The check does not
 * try to prove that a policy is perfect, only that the baseline exists; a
 * missing header is a fact, while policy quality needs a human review.
 */

function has(headers, name) {
  return typeof headers[name] === "string" && headers[name].trim() !== "";
}

export function checkHeaders(snapshot = {}) {
  const headers = snapshot.headers || {};
  const url = snapshot.url || "";
  const isHttps = url.startsWith("https:");
  const findings = [];

  if (!has(headers, "content-security-policy")) {
    findings.push({
      id: "headers.csp_missing",
      category: "headers",
      severity: "error",
      title: "Content-Security-Policy is missing",
      detail: "The response does not send a Content-Security-Policy header, so the browser has no origin allowlist for scripts, styles, or frames.",
      remediation: "Define a CSP baseline in the framework config and verify it in staging before production.",
      url,
      evidence: "content-security-policy: (absent)",
    });
  }

  const csp = headers["content-security-policy"] || "";
  const frameProtected = has(headers, "x-frame-options") || /frame-ancestors/i.test(csp);
  if (!frameProtected) {
    findings.push({
      id: "headers.frame_protection_missing",
      category: "headers",
      severity: "warn",
      title: "Clickjacking protection is missing",
      detail: "Neither X-Frame-Options nor a CSP frame-ancestors directive is present.",
      remediation: "Send X-Frame-Options: DENY or a CSP frame-ancestors directive.",
      url,
      evidence: "x-frame-options: (absent); frame-ancestors: (absent)",
    });
  }

  if (!has(headers, "referrer-policy")) {
    findings.push({
      id: "headers.referrer_policy_missing",
      category: "headers",
      severity: "warn",
      title: "Referrer-Policy is missing",
      detail: "The browser decides how much referrer information to send to other origins.",
      remediation: "Send Referrer-Policy: strict-origin-when-cross-origin or stricter.",
      url,
      evidence: "referrer-policy: (absent)",
    });
  }

  if (!has(headers, "permissions-policy")) {
    findings.push({
      id: "headers.permissions_policy_missing",
      category: "headers",
      severity: "warn",
      title: "Permissions-Policy is missing",
      detail: "Powerful browser features such as geolocation and camera are not explicitly restricted.",
      remediation: "Send a Permissions-Policy that disables features the site does not use.",
      url,
      evidence: "permissions-policy: (absent)",
    });
  }

  if (!has(headers, "x-content-type-options")) {
    findings.push({
      id: "headers.x_content_type_options_missing",
      category: "headers",
      severity: "warn",
      title: "X-Content-Type-Options is missing",
      detail: "A browser may sniff a response as a different content type than the server declared.",
      remediation: "Send X-Content-Type-Options: nosniff.",
      url,
      evidence: "x-content-type-options: (absent)",
    });
  }

  if (isHttps && !has(headers, "strict-transport-security")) {
    findings.push({
      id: "headers.hsts_missing",
      category: "headers",
      severity: "warn",
      title: "Strict-Transport-Security is missing",
      detail: "An HTTPS response without HSTS can still be downgraded on the first visit.",
      remediation: "Send Strict-Transport-Security with a max-age of at least one year.",
      url,
      evidence: "strict-transport-security: (absent)",
    });
  }

  if (has(headers, "server") || has(headers, "x-powered-by")) {
    findings.push({
      id: "headers.version_disclosure",
      category: "headers",
      severity: "info",
      title: "The response discloses server or framework details",
      detail: "Server or X-Powered-By headers make version fingerprinting easier.",
      remediation: "Remove X-Powered-By and generic Server headers where the platform allows it.",
      url,
      evidence: `server: ${headers.server || "(absent)"}; x-powered-by: ${headers["x-powered-by"] || "(absent)"}`,
    });
  }

  if (!has(headers, "cross-origin-opener-policy")) {
    findings.push({
      id: "headers.coop_missing",
      category: "headers",
      severity: "info",
      title: "Cross-Origin-Opener-Policy is missing",
      detail: "The page does not isolate its browsing context from cross-origin openers.",
      remediation: "Send Cross-Origin-Opener-Policy: same-origin when the application does not depend on popup communication.",
      url,
      evidence: "cross-origin-opener-policy: (absent)",
    });
  }

  return findings;
}
