const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createReleaseServer} = require('../managed/release-server.cjs');
const {tarExecutable} = require('../managed/protocol.cjs');
const {resolveRelease, validateManifest, validateArchiveEntries,acquireInstallLock} = require('../managed/launcher.cjs');

const token = 'test-only-managed-release-token';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'managed-release-'));
  const source = path.join(dir,'source');
  await fs.mkdir(source);
  await fs.mkdir(path.join(dir,'releases'));
  await fs.writeFile(path.join(source,'index.js'),'// test runtime\n');
  await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'test',version:'1.0.0'}));
  await fs.writeFile(path.join(source,'package-lock.json'),'{}');
  const archive = path.join(dir,'source.tar.gz');
  execFileSync(tarExecutable(),['-czf',archive,'-C',source,'.']);
  const body = await fs.readFile(archive);
  const manifest = {revision:'a'.repeat(40),sha256:createHash('sha256').update(body).digest('hex'),size:body.length};
  await fs.copyFile(archive,path.join(dir,'releases',manifest.sha256+'.tar.gz'));
  await fs.writeFile(path.join(dir,'current.json'),JSON.stringify(manifest));
  const server = createReleaseServer({root:dir,token});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url = 'http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  return {dir,url,manifest};
}

test('service health is readable; manifests and archives require authentication',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.url+'/health')).status,200);
  assert.equal((await fetch(f.url+'/v1/current')).status,401);
  assert.equal((await fetch(f.url+'/v1/current',{headers:{authorization:'Bearer wrong'}})).status,401);
  const response=await fetch(f.url+'/v1/current',{headers:{authorization:'Bearer '+token}});
  assert.deepEqual(await response.json(),f.manifest);
  assert.equal((await fetch(f.url+'/v1/releases/not-an-artifact',{headers:{authorization:'Bearer '+token}})).status,404);
});

test('managed release installs once and caches by runtime ABI; failed auth never falls back',async t=>{
  const f=await fixture(t); let installs=0;
  const options={url:f.url,token,cacheRoot:path.join(f.dir,'cache'),install:async()=>{installs++;}};
  const first=await resolveRelease(options);
  const next=await resolveRelease(options);
  assert.equal(first.revision,f.manifest.revision);
  assert.equal(next.runtimeRoot,first.runtimeRoot);
  assert.equal(installs,1);
  await assert.rejects(resolveRelease({...options,token:'invalid'}),/HTTP 401/);
});

test('corrupted archive is rejected before install or last-good promotion',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.dir,'releases',f.manifest.sha256+'.tar.gz'),'corrupt');
  let installs=0;
  const cacheRoot=path.join(f.dir,'cache');
  await assert.rejects(resolveRelease({url:f.url,token,cacheRoot,install:async()=>installs++}),/size|SHA256/i);
  assert.equal(installs,0);
  await assert.rejects(fs.access(path.join(cacheRoot,'last-good.json')));
});

test('concurrent launchers share one complete install',async t=>{
  const f=await fixture(t);let installs=0;
  const options={url:f.url,token,cacheRoot:path.join(f.dir,'cache'),install:async()=>{installs++;await new Promise(r=>setTimeout(r,100));}};
  const results=await Promise.all([resolveRelease(options),resolveRelease(options)]);
  assert.equal(installs,1);
  assert.equal(results[0].runtimeRoot,results[1].runtimeRoot);
});

test('only network failure may reuse an already verified release',async t=>{
  const f=await fixture(t);const cacheRoot=path.join(f.dir,'cache');
  const options={url:f.url,token,cacheRoot,install:async()=>{}};
  const first=await resolveRelease(options);
  const warnings=[];
  const offline=await resolveRelease({...options,fetchImpl:async()=>{throw new TypeError('network unavailable');},warn:message=>warnings.push(message)});
  assert.equal(offline.runtimeRoot,first.runtimeRoot);
  assert.equal(offline.offline,true);
  assert.match(warnings.join(' '),/cached|cache/i);
  await assert.rejects(resolveRelease({...options,fetchImpl:async()=>new Response('{broken',{status:200})}),/manifest/i);
});

test('unsafe manifests and archive paths cannot select files outside cache',()=>{
  assert.throws(()=>validateManifest({revision:'../escape',sha256:'a'.repeat(64),size:10}),/manifest/i);
  for(const bad of ['../outside','/etc/passwd','C:/escape','dir/../../escape','dir\\..\\escape']) assert.throws(()=>validateArchiveEntries(bad),/unsafe/i);
  assert.doesNotThrow(()=>validateArchiveEntries('./\n./index.js\n./managed/launcher.cjs\n'));
});

test('installation lock is released by the OS when its owner process dies',{timeout:10000},async t=>{
  assert.equal(typeof acquireInstallLock,'function');
  const key=path.join(os.tmpdir(),'managed-lock-crash-'+process.pid);
  const module=path.resolve(__dirname,'../managed/launcher.cjs');
  const child=spawn(process.execPath,['-e',`require(${JSON.stringify(module)}).acquireInstallLock(${JSON.stringify(key)}).then(()=>{console.log('ready');setInterval(()=>{},1000)})`],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  t.after(()=>child.kill());
  await once(child.stdout,'data');
  child.kill();await once(child,'exit');
  const release=await acquireInstallLock(key,{timeoutMs:2000});
  await release();
});

test('abandoned legacy lock directories cannot break concurrent installation',async t=>{
  const f=await fixture(t);let installs=0;
  const cacheRoot=path.join(f.dir,'cache');
  const key=[process.platform,process.arch,process.versions.modules].join('-');
  const legacy=path.join(cacheRoot,'releases',f.manifest.sha256+'-'+key+'.lock');
  await fs.mkdir(legacy,{recursive:true});
  await fs.writeFile(path.join(legacy,'owner.json'),JSON.stringify({pid:2147483000}));
  const options={url:f.url,token,cacheRoot,install:async()=>{installs++;await new Promise(r=>setTimeout(r,100));}};
  const values=await Promise.all(Array.from({length:10},()=>resolveRelease(options)));
  assert.equal(installs,1);assert.equal(values.length,10);
});
