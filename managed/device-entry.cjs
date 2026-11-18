'use strict';
// Optional adapter for clients sharing their existing OpenCode environment.
// Credential values stay on this device and are never sent to the release host.
//
// This is the stable entry point every managed client is configured to run, so
// it is also the choke point for maintenance admission. The check lives here as
// well as in launcher.cjs on purpose: a client may be pinned to an older cached
// launcher that predates the gate, and this file is what still runs first.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {assertAdmission,managedCacheRoot}=require('./admission.cjs');

const SUPPORTED_CLIENTS=['codex','opencode','antigravity','unknown'];

function buildEnvironment({client,env=process.env,configPath}={}) {
  const merged={...env};
  const config=configPath||path.join(os.homedir(),'.config','opencode','opencode.json');
  if(fs.existsSync(config)) {
    const source=JSON.parse(fs.readFileSync(config,'utf8'));
    const record=source.mcp?.['dev-workflow']||source.mcp?.servers?.['dev-workflow'];
    for(const [name,value] of Object.entries(record?.environment||record?.env||{})) {
      if(typeof value!=='string') continue;
      const canonicalEndpoint=name==='DEVWF_MONITOR_URL'||name==='DEVWF_RELEASE_URL';
      if(merged[name]&&!canonicalEndpoint) continue;
      const ref=/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      merged[name]=ref?(env[ref[1]]||''):value;
    }
  }
  merged.DEVWF_AGENT=client;
  return merged;
}

/**
 * Admit and start the managed launcher for one client.
 *
 * Returns `{ok:false, code, message}` when maintenance refuses the launch, so
 * the caller can exit non-zero without spawning anything.
 */
function runDeviceEntry({
  argv=process.argv,
  env=process.env,
  spawnImpl=spawn,
  configPath=null,
  now=Date.now,
}={}) {
  const client=argv[2]||env.DEVWF_AGENT||'unknown';
  if(!SUPPORTED_CLIENTS.includes(client)) throw new Error('Unsupported MCP client');

  const merged=buildEnvironment({client,env,configPath});

  // Fail closed before the launcher is even started. This is what covers a
  // cached launcher that has no admission check of its own.
  try {
    assertAdmission({cacheRoot:managedCacheRoot(merged),env:merged,now:now()});
  } catch(error) {
    return {ok:false,code:error.code||'ADMISSION_REFUSED',message:error.message};
  }

  const child=spawnImpl(process.execPath,[path.join(__dirname,'launcher.cjs'),...argv.slice(3)],{env:merged,stdio:'inherit',windowsHide:true});

  // Handlers are attached before the re-check: a failed spawn can emit `error`
  // immediately, and an unhandled error event would crash the entry point.
  child.on('error',()=>{console.error('dev-workflow: managed entry failed');process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});

  // Re-check after spawn. An older cached launcher cannot re-check for itself,
  // so a window that opens between the check above and the launcher actually
  // loading would otherwise be missed. The child is one we just started, so
  // stopping it is safe.
  try {
    assertAdmission({cacheRoot:managedCacheRoot(merged),env:merged,now:now()});
  } catch(error) {
    try { child.kill(); } catch {}
    return {ok:false,code:error.code||'ADMISSION_REFUSED',message:error.message};
  }

  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  return {ok:true,child};
}

if(require.main===module) {
  const result=runDeviceEntry();
  if(!result.ok) {
    console.error(result.message);
    process.exitCode=1;
  }
}

module.exports={runDeviceEntry,buildEnvironment,SUPPORTED_CLIENTS};
