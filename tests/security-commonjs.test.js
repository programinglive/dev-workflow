import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);

test('CommonJS release tooling uses the same sanitizer before logs and generated documents',async()=>{
  const bridge=require('../security/log-bridge.cjs');
  await bridge.ready;
  assert.throws(()=>bridge.assertSafeKnowledge('PASSWORD=generated-doc-fixture'),{code:'SECRET_CONTENT_DENIED'});
  const lines=[];
  bridge.safeLog('info',{password:'cjs-log-fixture'},{write:value=>lines.push(value)});
  await bridge.flushLogs();
  assert.ok(!lines.join('').includes('cjs-log-fixture'));
  assert.ok(lines.join('').includes('[REDACTED]'));
});
