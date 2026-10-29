import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const {runRelease,runProjectTests}=require('../scripts/release.cjs');
const {ready,flushLogs}=require('../security/log-bridge.cjs');

test('release test runner executes npm tests in the supplied directory on Windows',async()=>{
  await ready;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'release-npm-'));
  try {
    await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
    const result=runProjectTests({cwd:dir,env:process.env});
    assert.equal(result.status,0,result.error?.message);
  } finally {await flushLogs();await fs.rm(dir,{recursive:true,force:true});}
});

test('release stops when tests cannot finish or versioning cannot execute',async()=>{
  await ready;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'release-process-'));
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
  try {
    for(const failureAt of [1,2]) {
      let calls=0;
      const result=runRelease({cwd:dir,argv:['node','release.cjs','minor'],env:{},
        dependencies:{isWorkingTreeClean:()=>true,fsExistsSync:()=>true},
        spawn:()=>++calls===failureAt ? {status:null,error:new Error('process failed')} : {status:0},
      });
      assert.notEqual(result.status,0);
      assert.equal(calls,failureAt,'No release operation may follow a failed subprocess');
    }
  } finally {await flushLogs();await fs.rm(dir,{recursive:true,force:true});}
});
