#!/usr/bin/env node
import { safeLog } from '../../security/sanitizer.js';

/**
 * Manual smoke test for the dashboard auth flow.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 \
 *   AUTH_USERNAME=you \
 *   AUTH_PASSWORD=secret \
 *   node scripts/test-auth-flow.js
 *
 * Nothing is hardcoded. Credentials used to live in this file, which meant a
 * real password sat in git history. They are now read from the environment and
 * the script exits with a clear message when they are missing.
 *
 * This is a manual tool, not part of `npm test`: it needs a running server and
 * a real account. `npm test` used to pick it up because it lives under
 * scripts/, which is why it appeared as a failing test.
 */

const API_BASE_URL = process.env.API_BASE_URL;
const USERNAME = process.env.AUTH_USERNAME;
const PASSWORD = process.env.AUTH_PASSWORD;

function fail(message) {
  safeLog('error', `✖ ${message}`);
  process.exit(1);
}

if (!API_BASE_URL) {
  fail('Set API_BASE_URL, e.g. API_BASE_URL=http://localhost:3000');
}
if (!USERNAME || !PASSWORD) {
  fail('Set AUTH_USERNAME and AUTH_PASSWORD. Never hardcode credentials in this file.');
}

async function testAuthFlow() {
  safeLog('info', `Starting auth flow test against ${API_BASE_URL}\n`);

  const loginRes = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });

  safeLog('info', `1. login            -> ${loginRes.status}`);
  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${loginRes.statusText}`);
  }

  const loginData = await loginRes.json();
  const token = loginData.token;
  safeLog('info', token ? '   token received' : '   no token (cookie session mode)');

  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  const meRes = await fetch(`${API_BASE_URL}/api/auth/me`, { headers });
  safeLog('info', `2. /api/auth/me     -> ${meRes.status}`);
  if (meRes.ok) {
    const me = await meRes.json();
    safeLog('info', `   authenticated as ${me.username}`);
  } else {
    safeLog('info', `   ${(await meRes.text()).slice(0, 200)}`);
  }

  const historyRes = await fetch(`${API_BASE_URL}/api/history`, { headers });
  safeLog('info', `3. /api/history     -> ${historyRes.status}`);
  if (historyRes.ok) {
    const data = await historyRes.json();
    safeLog('info', `   entries: ${Array.isArray(data.history) ? data.history.length : 0}`);
  }
}

testAuthFlow().catch((error) => {
  safeLog('error', `\n✖ Test failed: ${error.message}`);
  process.exit(1);
});
