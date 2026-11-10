'use strict';
// Stable bootstrap: release code is fetched centrally, executed locally, and pinned
// for this connection. Never print diagnostics to MCP stdout.
const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {createHash,randomUUID}=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {validateManifest,validateArchiveEntries,MAX_ARCHIVE_BYTES,tarExecutable}=require('./protocol.cjs');
const execFileAsync=promisify(execFile);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const runtimeKey=()=>[process.platform,process.arch,process.versions.modules].join('-');

async function readBounded(response,limit) {
  const chunks=[];let size=0;
  for await(const chunk of response.body) {
    size+=chunk.length;
    if(size>limit) throw new Error('Managed release response exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function request(url,token,fetchImpl) {
  let response;
  try { response=await fetchImpl(url,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15_000)}); }
  catch(error) { const safe=new Error('Managed release service unreachable');safe.network=true;throw safe; }
  if(!response.ok) throw new Error('Managed release HTTP '+response.status);
  return response;
}
async function jsonFile(file) {try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}
async function atomicJson(file,value) {
  const temporary=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600});
  await fs.rename(temporary,file);
}
async function installed(root,manifest) {
  const marker=await jsonFile(path.join(root,'.managed-verified.json'));
  if(marker?.sha256!==manifest.sha256||marker?.revision!==manifest.revision||marker?.runtimeKey!==runtimeKey()) return false;
  try {return (await fs.stat(path.join(root,'index.js'))).isFile();} catch{return false;}
}
function releaseRoot(cacheRoot,manifest) {return path.join(cacheRoot,'releases',manifest.sha256+'-'+runtimeKey());}
async function acquireInstallLock(key,{timeoutMs=360_000}={}) {
  // A kernel-owned listener is an installation mutex, not an API.
  // Unlike lock directories it is released on process death, has no partial
  // owner-file state, and cannot be stolen by concurrent stale-lock cleaners.
  const canonical=process.platform==='win32'?path.resolve(key).toLowerCase():path.resolve(key);
  const digest=createHash('sha256').update(canonical).digest();
  // Windows reserves TCP port ranges dynamically (Hyper-V/WSL). Named pipes
  // avoid those reservations and still disappear when the owner process dies.
  const endpoint=process.platform==='win32'
    ? {path:'\\\\.\\pipe\\devwf-install-'+digest.toString('hex'),exclusive:true}
    : {host:'127.0.0.1',port:30000+(digest.readUInt32BE(0)%30000),exclusive:true};
  const until=Date.now()+timeoutMs;
  for(;;) {
    const server=net.createServer(socket=>socket.destroy());
    try {
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
      return ()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    } catch(error) {
      server.close();
      if(error.code!=='EADDRINUSE') throw error;
    }
    if(Date.now()>until) throw new Error('Managed release installation lock timed out');
    await sleep(100);
  }
}
async function installDependencies(root) {
  let executable,args;
  const npmCandidates=[path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),'/usr/share/nodejs/npm/bin/npm-cli.js'];
  const npm=npmCandidates.find(file=>fsSync.existsSync(file));
  if(npm){executable=process.execPath;args=[npm];}
  else if(process.platform==='win32') throw new Error('npm CLI was not found beside Node');
  else {executable='npm';args=[];}
  // Install dependencies only, without running this package's user-setup hooks.
  const options={cwd:root,windowsHide:true,maxBuffer:4*1024*1024,timeout:180_000,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH||'')}};
  try {
    await execFileAsync(executable,[...args,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],options);
    await execFileAsync(executable,[...args,'rebuild','better-sqlite3','--no-audit','--no-fund'],options);
    await execFileAsync(process.execPath,['-e',"const D=require('better-sqlite3');const d=new D(':memory:');d.close()"],options);
  } catch {throw new Error('Managed release dependency installation failed; prior release retained');}
}

async function resolveRelease({url,token,cacheRoot,fetchImpl=fetch,install=installDependencies,warn=message=>console.error(message)}) {
  if(!url||!token) throw new Error('Managed MCP URL and authentication are required');
  const origin=new URL(url);
  if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.search||origin.hash) throw new Error('Invalid managed MCP service URL');
  url=origin.href.replace(/\/+$/,'');
  await fs.mkdir(path.join(cacheRoot,'releases'),{recursive:true});
  let manifest;
  try {
    const response=await request(url+'/v1/current',token,fetchImpl);
    try {manifest=validateManifest(JSON.parse((await readBounded(response,64*1024)).toString('utf8')));}
    catch{throw new Error('Invalid managed release manifest');}
  } catch(error) {
    if(!error.network) throw error;
    const previous=await jsonFile(path.join(cacheRoot,'last-good.json'));
    if(!previous) throw error;
    manifest=validateManifest(previous);
    const runtimeRoot=releaseRoot(cacheRoot,manifest);
    if(!await installed(runtimeRoot,manifest)) throw error;
    warn('dev-workflow: central service unavailable; using verified cached release '+manifest.revision.slice(0,12));
    return {...manifest,runtimeRoot,offline:true};
  }
  const runtimeRoot=releaseRoot(cacheRoot,manifest);
  const releaseLock=await acquireInstallLock(runtimeRoot);
  let stage;
  try {
    if(!await installed(runtimeRoot,manifest)) {
      if(fsSync.existsSync(runtimeRoot)) throw new Error('Managed release cache is incomplete; manual inspection required');
      const response=await request(url+'/v1/releases/'+manifest.sha256+'.tar.gz',token,fetchImpl);
      const body=await readBounded(response,MAX_ARCHIVE_BYTES);
      if(body.length!==manifest.size) throw new Error('Managed release archive size mismatch');
      if(createHash('sha256').update(body).digest('hex')!==manifest.sha256) throw new Error('Managed release SHA256 mismatch');
      stage=runtimeRoot+'.stage-'+randomUUID();
      await fs.mkdir(stage);
      const archive=path.join(stage,'source.tar.gz');
      await fs.writeFile(archive,body);
      const {stdout}=await execFileAsync(tarExecutable(),['-tzf',archive],{maxBuffer:4*1024*1024,windowsHide:true});
      validateArchiveEntries(stdout);
      const details=await execFileAsync(tarExecutable(),['-tvzf',archive],{maxBuffer:4*1024*1024,windowsHide:true});
      if(details.stdout.split(/\r?\n/).some(line=>/^[lh]/.test(line))) throw new Error('Unsafe archive link');
      await execFileAsync(tarExecutable(),['-xzf',archive,'-C',stage,'--no-same-owner'],{windowsHide:true});
      await fs.unlink(archive);
      if(!fsSync.existsSync(path.join(stage,'index.js'))||!fsSync.existsSync(path.join(stage,'package-lock.json'))) throw new Error('Managed release runtime is incomplete');
      warn('dev-workflow: preparing managed release '+manifest.revision.slice(0,12));
      await install(stage);
      await atomicJson(path.join(stage,'.managed-verified.json'),{...manifest,runtimeKey:runtimeKey()});
      await fs.rename(stage,runtimeRoot);stage=null;
    }
    await atomicJson(path.join(cacheRoot,'last-good.json'),manifest);
    return {...manifest,runtimeRoot,offline:false};
  } finally {
    if(stage) await fs.rm(stage,{recursive:true,force:true});
    await releaseLock();
  }
}
async function main() {
  const cacheRoot=process.env.DEVWF_MANAGED_CACHE||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','share'),'ProgramingLive','ManagedMCP');
  const release=await resolveRelease({url:process.env.DEVWF_RELEASE_URL||'http://100.77.138.14:3101',token:process.env.DEVWF_MONITOR_TOKEN,cacheRoot});
  if(process.argv.includes('--resolve-only')) {console.log(JSON.stringify({revision:release.revision,version:release.version??null,runtimeRoot:release.runtimeRoot,offline:release.offline}));return;}
  console.error('dev-workflow: managed release '+release.revision.slice(0,12)+(release.version?' ('+release.version+')':''));
  const child=spawn(process.execPath,[path.join(release.runtimeRoot,'index.js')],{
    cwd:process.cwd(),
    env:{
      ...process.env,
      PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH||''),
      DEVWF_RELEASE_REVISION:release.revision,
      // Handed to the server so it can report its own version to the monitor.
      // Without this, "connected" cannot distinguish a current build from an
      // old one, and finding out needs an SSH session per device.
      ...(release.version?{DEVWF_RELEASE_VERSION:release.version}:{}),
    },
    stdio:'inherit',
    windowsHide:true,
  });
  child.on('error',()=>{console.error('dev-workflow: managed executor failed to start');process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
}
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={resolveRelease,validateManifest,validateArchiveEntries,acquireInstallLock};
