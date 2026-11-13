import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { hapusSementara } from "./helpers/hapus-sementara.js";
import { WorkflowState } from '../workflow-state.js';
import { SqliteAdapter } from '../db/adapters/sqlite.js';
import { MysqlAdapter } from '../db/adapters/mysql.js';
import { PostgresAdapter } from '../db/adapters/postgres.js';
import { handleToolCall } from '../tools/handlers.js';
import { normalizeRequestArgs } from '../utils.js';
import { exec } from '../exec.js';
import { createGitMock,testUtils } from './test-helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const key='gh'+'p_'+'Z1y2X3w4'.repeat(5);
const run=promisify(execFile);
async function temporary(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'knowledge-security-'));
  const terbuka=[];
  try {
    // `closeState` mendaftarkan WorkflowState yang membuka koneksi SQLite.
    // Tanpa menutupnya, handle tetap dipegang proses dan menghapus direktori
    // sementara SELALU gagal di Windows dengan EBUSY - mencoba ulang tidak
    // menolong, karena yang menahan adalah proses ini sendiri.
    await fn(dir,(s)=>terbuka.push(s));
  } finally {
    for(const s of terbuka){
      try { if(s && s.dbAdapter && typeof s.dbAdapter.close==='function') await s.dbAdapter.close(); } catch {}
      try { if(s && s.dbAdapter && s.dbAdapter.db && typeof s.dbAdapter.db.close==='function') s.dbAdapter.db.close(); } catch {}
    }
    await hapusSementara(dir);
  }
}
function call(name,args,state,extra={}) {
  return handleToolCall({request:{params:{name,arguments:args}},normalizeRequestArgs,workflowState:state,...extra});
}

test('tool input rejected before any JSON/DB persistence with safe finding details',async()=>temporary(async (dir,daftar)=>{
  const state=new WorkflowState(path.join(dir,'state.json'));daftar(state); await state.load();
  const before=await fs.readFile(state.stateFile,'utf8');
  const response=await call('start_task',{description:`deploy with ${key}`,type:'feature'},state);
  assert.equal(response.isError,true);
  assert.ok(!JSON.stringify(response).includes(key));
  assert.ok(JSON.stringify(response).includes('suggested_secret_ref'));
  assert.equal(await fs.readFile(state.stateFile,'utf8'),before);
}));

test('all adapters reject direct unsafe writes before connecting',async()=>{
  for(const Adapter of [SqliteAdapter,MysqlAdapter,PostgresAdapter]) {
    const adapter=new Adapter({dbPath:':memory:'});
    let connected=false; adapter.connect=async()=>{connected=true;};
    await assert.rejects(adapter.insertHistoryEntry('user','project',{taskDescription:key}),{code:'SECRET_CONTENT_DENIED'});
    await assert.rejects(adapter.saveState('user','project',{password:'raw-short-fixture'}),{code:'SECRET_CONTENT_DENIED'});
    assert.equal(connected,false);
  }
});

test('PostgreSQL summary query preserves classification and refuses SECRET cache writes',async()=>{
  const adapter=new PostgresAdapter();
  adapter.connect=async()=>{};
  let written=false;
  adapter.pool={query:async(sql)=>{
    if(/SELECT/i.test(sql)) {
      assert.match(sql,/SELECT\s+classification\s*,/i,'Classification must travel with source history rows');
      return {rows:[{classification:'SECRET',task_description:'opaque-pg-classified-fixture',task_type:'feature',timestamp:new Date().toISOString()}]};
    }
    written=true;return {rows:[]};
  }};
  await assert.rejects(adapter.updateSummaryForUser('u','p'),{code:'SECRET_CONTENT_DENIED'});
  assert.equal(written,false);
});

test('SQLite stores references and never unsafe history or derived summaries',async()=>{
  const adapter=new SqliteAdapter({dbPath:':memory:'}); await adapter.connect();
  try {
    await assert.rejects(adapter.insertHistoryEntry('u','p',{taskDescription:key,taskType:'feature'}));
    await assert.rejects(adapter.saveState('u','p',{token:key}));
    await assert.rejects(adapter.saveState('u','p',{toJSON(){return {password:'serializer-fixture'};}}),{code:'SECRET_CONTENT_DENIED'});
    assert.equal(adapter.db.prepare('SELECT count(*) AS n FROM workflow_history').get().n,0);
    await adapter.insertHistoryEntry('u','p',{classification:'CONFIDENTIAL',taskDescription:'Database uses env://PROJECT_DATABASE_URL',taskType:'feature',commitMessage:'feat: metadata'});
    const rows=adapter.db.prepare('SELECT * FROM workflow_history').all();
    assert.equal(rows[0].classification,'CONFIDENTIAL');
    assert.ok(!JSON.stringify(rows).includes(key));
    // External SQL writers are outside the boundary. Derived writes must still reject them.
    adapter.db.prepare('UPDATE workflow_history SET task_description=?').run(key);
    await assert.rejects(adapter.updateSummaryForUser('u','p'),{code:'SECRET_CONTENT_DENIED'});
  }finally{adapter.db.close();}
});

test('JSON persistence rejects secrets before writing state or generated knowledge',async()=>temporary(async (dir,daftar)=>{
  const state=new WorkflowState(path.join(dir,'state.json'));daftar(state); await state.load();
  state.state.taskDescription=key;
  await assert.rejects(state.save(),{code:'SECRET_CONTENT_DENIED'});
  assert.ok(!(await fs.readFile(state.stateFile,'utf8')).includes(key));
  // Ringkasan proyek mungkin belum pernah ditulis untuk sesi baru; yang penting
  // adalah bila ada, isinya tidak memuat rahasia.
  const summary=await fs.readFile(path.join(dir,'project-summary.json'),'utf8').catch(()=>'');
  assert.ok(!summary.includes(key));
}));

test('legacy knowledge and async handler failures are filtered before MCP output',async()=>temporary(async (dir,daftar)=>{
  const state=new WorkflowState(path.join(dir,'state.json'));daftar(state); await state.load();
  state.state.history=[{taskDescription:key,taskType:'feature',timestamp:new Date().toISOString()}];
  assert.ok(!JSON.stringify(await call('project_summary',{},state)).includes(key));
  state.state.history=[{classification:'SECRET',taskDescription:'opaque-classified-content',taskType:'feature'}];
  assert.ok(!JSON.stringify(await call('project_summary',{},state)).includes('opaque-classified-content'));
  state.reconcileWithDisk=async()=>{throw new Error('PASSWORD=async-error-fixture');};
  const response=await call('start_task',{description:'safe task',type:'feature'},state);
  assert.ok(!JSON.stringify(response).includes('async-error-fixture'));
}));

test('child stdout/stderr and error responses are sanitized',async()=>{
  const success=await exec(`node -e "console.log('PASSWORD=child-output-fixture');console.error('TOKEN=child-stderr-fixture')"`);
  assert.ok(!JSON.stringify(success).includes('child-output-fixture'));
  assert.ok(!JSON.stringify(success).includes('child-stderr-fixture'));
  await assert.rejects(exec(`node -e "console.error('PASSWORD=child-error-fixture');process.exit(1)"`),err=>!JSON.stringify(err).includes('child-error-fixture'));
});

test('shell-free runtime execution preserves multiline commit arguments literally',async()=>{
  const value='literal "quoted" text %NOT_EXPANDED%\nsecond line';
  const result=await exec('display-only command',{executable:process.execPath,arguments:['-e','console.log(process.argv[1])',value]});
  assert.equal(result.stdout.trim(),value);
});

test('CLI stdout and stderr do not contain synthetic credentials',async()=>temporary(async (dir,daftar)=>{
  const script=path.resolve('index.js');
  const result=await run(process.execPath,[script,'call','start_task','--args',JSON.stringify({description:key,type:'feature'})],{cwd:dir,env:{...process.env,DEV_WORKFLOW_USER_ID:'security-test',DEV_WORKFLOW_SECURITY_MODE:'strict'}}).catch(err=>err);
  const {stdout,stderr}=result;
  assert.equal(result.code,1,'Rejected CLI knowledge must return a failing exit status');
  assert.ok(!String(stdout).includes(key)); assert.ok(!String(stderr).includes(key));
}));

test('legacy owner markers migrate before knowledge validation',async()=>temporary(async (dir,daftar)=>{
  await fs.writeFile(path.join(dir,'.workflow-state.json'),JSON.stringify({
    currentPhase:'coding',taskDescription:'Preserve ongoing work',taskType:'feature',history:[],
    owner:{token:'proc-1234-abcd',pid:1234},
  }));
  const state=new WorkflowState(path.join(dir,'.state','workflow-state.json'));daftar(state);
  await state.load();
  const saved=JSON.parse(await fs.readFile(state.stateFile,'utf8'));
  assert.equal(saved.taskDescription,'Preserve ongoing work');
  assert.equal(saved.owner.processMarker,'proc-1234-abcd');
  assert.equal(saved.owner.token,undefined);
}));

test('shared project history rejects unsafe direct writes after session integration',async()=>temporary(async (dir,daftar)=>{
  const userDir=path.join(dir,'.state','users','fixture-user');
  await fs.mkdir(userDir,{recursive:true});
  const state=new WorkflowState(path.join(userDir,'workflow-state.ses_fixture.json'));daftar(state);
  await state.load();
  state.state.history=[{taskDescription:key,taskType:'feature',timestamp:new Date().toISOString()}];
  await assert.rejects(state.writeHistoryFile(),{code:'SECRET_CONTENT_DENIED'});
  const persisted=await fs.readFile(state.historyFile,'utf8').catch(()=> '');
  assert.ok(!persisted.includes(key));
}));

test('actual stdio MCP response and stderr exclude rejected secret material',async()=>temporary(async (dir,daftar)=>{
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('index.js')],cwd:dir,stderr:'pipe',env:{...process.env,DEV_WORKFLOW_USER_ID:'wire-security-test'}});
  const client=new Client({name:'security-regression',version:'1.0.0'});
  let diagnostics='';transport.stderr?.on('data',chunk=>{diagnostics+=chunk.toString();});
  try {
    await client.connect(transport);
    const response=await client.callTool({name:'start_task',arguments:{description:key,type:'feature'}});
    assert.equal(response.isError,true);
    assert.ok(!JSON.stringify(response).includes(key));
    assert.ok(!diagnostics.includes(key));
  } finally {await client.close();}
}));

test('release tool rejects arbitrary shell commands and protected file reads before exec',async()=>temporary(async (dir,daftar)=>{
  const state=new WorkflowState(path.join(dir,'state.json'));daftar(state);await state.load();
  Object.assign(state.state,{currentPhase:'release',readyToCommit:true,readyCheckCompleted:true,commitAndPushCompleted:true});
  let executed=false;
  const response=await call('perform_release',{command:'cat .env'},state,{exec:async()=>{executed=true;return {stdout:''};},git:createGitMock(),utils:testUtils});
  assert.equal(executed,false);
  assert.equal(response.isError,true);
}));
