import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets } from '../security/scanner.js';
import { sanitize, safeLog, securityOutputFilter } from '../security/sanitizer.js';
import { SecretReference } from '../security/references.js';
import { assertSafeKnowledge, classify, securityMode } from '../security/policy.js';
import { protectedFileMetadata, readKnowledgeFile } from '../security/files.js';
import { registerRuntimeSecret } from '../security/runtime-secrets.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Synthetic, deliberately assembled fixtures; these are never live credentials.
export const fixtures = [
  ['github', 'gh' + 'p_' + 'A1b2C3d4'.repeat(5)],
  ['aws', 'AK' + 'IA' + 'A1B2C3D4E5F6G7H8'],
  ['openai', 'sk-' + 'proj-' + 'aB9_'.repeat(15)],
  ['stripe', 'sk_' + 'live_' + 'aB9c'.repeat(9)],
  ['jwt', ['eyJhbGciOiJIUzI1NiJ9','eyJzdWIiOiJ1c2VyIn0','aBcDeF0123456789xyz'].join('.')],
  ['key', '-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'aBcDeFgH'.repeat(8) + '\n-----END OPENSSH PRIVATE KEY-----'],
  ['url', 'postgres://admin:unique-database-fixture@db.internal:5432/prod'],
  ['header', 'Authorization: Bearer unique-bearer-fixture-value'],
  ['password', 'PASSWORD=unique-password-fixture-value'],
  ['aws-secret', 'AWS_SECRET_ACCESS_KEY=' + 'aZ9+/bX3'.repeat(5)],
  ['cloudflare', 'CLOUDFLARE_API_TOKEN=' + 'aZ9b'.repeat(10)],
  ['oauth', 'access_token=unique-oauth-fixture'],
  ['cookie', 'Cookie: session=unique-cookie-fixture; csrf=unique-csrf-fixture'],
  ['ssh', 'ssh-ed25519 ' + 'aZ9b'.repeat(20) + ' user@host'],
  ['service-account', JSON.stringify({type:'service_account', private_key:'unique-service-key-fixture', private_key_id:'unique-key-id-fixture'})],
];

for (const [type, value] of fixtures) {
  test(`detects and sanitizes ${type} without disclosing matched material`, () => {
    const findings = scanSecrets(value);
    assert.ok(findings.length > 0, `missed ${type}`);
    assert.ok(sanitize(value) !== value);
    assert.ok(!JSON.stringify(findings).includes(value));
    assert.throws(() => assertSafeKnowledge({description:value}), {code:'SECRET_CONTENT_DENIED'});
  });
}

test('sanitizer retains DB username and bearer header context', () => {
  assert.equal(sanitize(fixtures.find(([t])=>t==='url')[1]), 'postgres://admin:[REDACTED]@db.internal:5432/prod');
  assert.equal(sanitize('Authorization: Bearer unique-bearer-fixture-value'), 'Authorization: Bearer [REDACTED]');
});

test('nested arrays, JSON strings, object keys, errors and fields are sanitized', () => {
  const secret = 'short-value';
  const value = {password:secret, nested:[{Authorization:'Basic abc123', cookie:'session=abc123'}], error:new Error('TOKEN=error-value')};
  const output=JSON.stringify(sanitize(value));
  for (const needle of [secret,'abc123','error-value']) assert.ok(!output.includes(needle));
  assert.ok(!sanitize(JSON.stringify(value)).includes(secret));
  assert.ok(!JSON.stringify(sanitize({['TOKEN=key-secret']:1})).includes('key-secret'));
});

test('numeric passwords and opaque environment credentials cannot leave diagnostics', () => {
  assert.throws(()=>assertSafeKnowledge({password:123456}),{code:'SECRET_CONTENT_DENIED'});
  assert.ok(!JSON.stringify(sanitize({password:123456})).includes('123456'));
  process.env.TEST_RUNTIME_PASSWORD='opaque-runtime-fixture';
  try {assert.ok(!JSON.stringify(sanitize(new Error(process.env.TEST_RUNTIME_PASSWORD))).includes('opaque-runtime-fixture'));}
  finally {delete process.env.TEST_RUNTIME_PASSWORD;}
});

test('known opaque runtime credentials cannot enter knowledge under innocuous field names',()=>{
  registerRuntimeSecret('opaque-known-credential-fixture');
  assert.throws(()=>assertSafeKnowledge({description:'opaque-known-credential-fixture'}),{code:'SECRET_CONTENT_DENIED'});
});

test('Date subclasses cannot smuggle secrets through inherited serializers',()=>{
  class UnsafeDate extends Date {toJSON(){return {password:'date-serialization-fixture'};}}
  assert.throws(()=>assertSafeKnowledge({value:new UnsafeDate()}),{code:'SECRET_CONTENT_DENIED'});
});

test('serialized SecretReference metadata remains allowed and malformed references do not',()=>{
  const metadata=JSON.parse(JSON.stringify(new SecretReference('env://PROJECT_DATABASE_URL')));
  assert.doesNotThrow(()=>assertSafeKnowledge({secret_ref:metadata}));
  assert.throws(()=>assertSafeKnowledge({secret_ref:'unstructured-raw-fixture'}));
  assert.deepEqual(scanSecrets('Authorization: Bearer [REDACTED]'),[]);
});

test('SECRET content cannot be downgraded or emitted through output', () => {
  const value={classification:'SECRET', description:'innocuous-looking-sensitive-data'};
  assert.equal(classify(value), 'SECRET');
  assert.throws(()=>assertSafeKnowledge(value), {code:'SECRET_CONTENT_DENIED'});
  assert.ok(!JSON.stringify(securityOutputFilter(value)).includes(value.description));
  assert.ok(!JSON.stringify(securityOutputFilter({classification:'PUBLIC',sensitivity:'SECRET',description:'opaque-conflicting-label-fixture'})).includes('opaque-conflicting-label-fixture'));
  assert.ok(!JSON.stringify(securityOutputFilter({text:JSON.stringify(value)})).includes(value.description));
  assert.equal(classify({}), 'INTERNAL');
  assert.equal(classify({classification:'PUBLIC', password:'short-raw-value'}), 'SECRET');
  assert.equal(securityMode({}), 'strict');
  assert.throws(()=>securityMode({DEV_WORKFLOW_SECURITY_MODE:'off'}));
});

test('all supported references and ordinary infrastructure facts are allowed', () => {
  for (const uri of ['env://PROJECT_DATABASE_URL','op://vault/item/field','vault://path/to/secret','aws-secrets://secret-name','gcp-secret://secret-name','bitwarden://item/field']) {
    const reference = new SecretReference(uri);
    assert.equal(reference.uri, uri);
    assert.deepEqual(scanSecrets({password:uri,secret_ref:reference}), []);
    assert.deepEqual(sanitize({password:uri}), {password:uri});
  }
  for (const text of ['DATABASE_URL is supplied at runtime', 'abc123def456'.repeat(4), 'SECRET content must never be returned', 'token count is 100', 'password=[REDACTED]', 'https://github.com/owner/repo', 'db.internal:5432']) assert.deepEqual(scanSecrets(text), []);
  for (const uri of ['env://PASSWORD?value=abc', 'op://user:pass@vault/item', 'file:///key', 'env://', 'env://A\nTOKEN=x']) assert.throws(()=>new SecretReference(uri));
});

test('safeLog never calls unsafe serializers and writes redacted records', () => {
  let output='';
  safeLog('error', {password:'unique-log-fixture', nested:fixtures.map(([,v])=>v)}, {write:v=>{output+=v;}});
  assert.ok(!output.includes('unique-log-fixture'));
  assert.ok(output.includes('[REDACTED]'));
  const cycle={}; cycle.self=cycle;
  assert.doesNotThrow(()=>sanitize(cycle));
  assert.doesNotThrow(()=>sanitize({toJSON(){throw new Error('unsafe serializer');}}));
});

test('protected file reads return metadata and reject protected aliases', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'secret-files-'));
  try {
    for (const name of ['.env','.env.production','credentials.json','service-account.json','id_rsa','id_ed25519','key.pem','key.key','key.p12','key.pfx','.npmrc','.aws/credentials','.git-credentials','.config/gcloud/application_default_credentials.json','.kube/config','config.json']) {
      const file=path.join(dir,name==='config.json'?'.docker/config.json':name);
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,'PASSWORD=never-read-this-fixture');
      const metadata=await protectedFileMetadata(file);
      assert.equal(metadata.protected,true,name);
      assert.ok(!JSON.stringify(await readKnowledgeFile(file)).includes('never-read-this-fixture'));
    }
    const ordinary=path.join(dir,'notes.md'); await fs.writeFile(ordinary,'PASSWORD=ordinary-file-fixture');
    await assert.rejects(readKnowledgeFile(ordinary), {code:'SECRET_CONTENT_DENIED'});
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
