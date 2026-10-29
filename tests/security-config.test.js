import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { databaseConnectionUrl,requireSigningSecret } from '../security/config.js';
import { securityJsonMiddleware,knowledgeInputMiddleware,authenticationToken,authCookieOptions } from '../security/http.js';
import { securityAudit } from '../security/audit.js';
import { getToolList } from '../tools/definitions.js';

test('database indirection is runtime-only and invalid names fail closed',()=>{
  const env={DEV_WORKFLOW_DB_URL_ENV:'PROJECT_DATABASE_URL',PROJECT_DATABASE_URL:'postgres://user:runtime-only-fixture@host/db',DEV_WORKFLOW_DB_URL:'ignored'};
  assert.equal(databaseConnectionUrl(env),env.PROJECT_DATABASE_URL);
  assert.throws(()=>databaseConnectionUrl({DEV_WORKFLOW_DB_URL_ENV:'MISSING'}));
  assert.throws(()=>databaseConnectionUrl({DEV_WORKFLOW_DB_URL_ENV:'env://DATABASE_URL'}));
  assert.throws(()=>requireSigningSecret('JWT_SECRET',{}));
  assert.throws(()=>requireSigningSecret('JWT_SECRET',{JWT_SECRET:'dev-workflow-secret-change-in-production'}));
});

test('browser auth uses HttpOnly cookies while existing bearer authentication remains usable',()=>{
  assert.equal(authenticationToken({headers:{cookie:'dev_workflow_auth=cookie-fixture'}}),'cookie-fixture');
  assert.equal(authenticationToken({headers:{authorization:'Bearer bearer-fixture'}}),'bearer-fixture');
  assert.equal(authCookieOptions().httpOnly,true);
  assert.equal(authCookieOptions().secure,true);
});

test('HTTP knowledge ingress rejects secrets and final JSON response sanitizes legacy rows',()=>{
  let written; let status;
  const res={json(v){written=v;return this;},status(n){status=n;return this;}};
  securityJsonMiddleware({},res,()=>{});
  res.json({history:[{description:'PASSWORD=http-response-fixture'}],token:'raw-api-token-fixture'});
  assert.ok(!JSON.stringify(written).includes('http-response-fixture'));
  assert.ok(!JSON.stringify(written).includes('raw-api-token-fixture'));
  let next=false;
  knowledgeInputMiddleware({body:{description:'PASSWORD=http-input-fixture'}},res,()=>{next=true;});
  assert.equal(next,false);assert.equal(status,422);
  assert.ok(!JSON.stringify(written).includes('http-input-fixture'));
});

test('security audit reports sanitized metadata and registers a discoverable MCP tool',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'security-audit-'));
  try{
    await fs.writeFile(path.join(dir,'.env'),'PASSWORD=protected-audit-fixture');
    await fs.writeFile(path.join(dir,'notes.md'),'TOKEN=notes-audit-fixture');
    const report=await securityAudit({root:dir,state:{description:'PASSWORD=state-audit-fixture'},env:{}});
    const output=JSON.stringify(report);
    for(const secret of ['protected-audit-fixture','notes-audit-fixture','state-audit-fixture']) assert.ok(!output.includes(secret));
    assert.ok(report.protected_files.length>0); assert.ok(report.potential_exposures.length>0);
    assert.equal(report.mode,'strict');
    assert.ok(getToolList().some(t=>t.name==='security_audit'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
