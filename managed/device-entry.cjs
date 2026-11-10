'use strict';
// Optional adapter for clients sharing their existing OpenCode environment.
// Credential values stay on this device and are never sent to the release host.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const client=process.argv[2]||process.env.DEVWF_AGENT||'unknown';
if(!['codex','opencode','antigravity','unknown'].includes(client)) throw new Error('Unsupported MCP client');
const env={...process.env};
const config=path.join(os.homedir(),'.config','opencode','opencode.json');
if(fs.existsSync(config)) {
  const source=JSON.parse(fs.readFileSync(config,'utf8'));
  const record=source.mcp?.['dev-workflow']||source.mcp?.servers?.['dev-workflow'];
  for(const [name,value] of Object.entries(record?.environment||record?.env||{})) {
    if(typeof value!=='string') continue;
    const canonicalEndpoint=name==='DEVWF_MONITOR_URL'||name==='DEVWF_RELEASE_URL';
    if(env[name]&&!canonicalEndpoint) continue;
    const ref=/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    env[name]=ref?(process.env[ref[1]]||''):value;
  }
}
env.DEVWF_AGENT=client;
const child=spawn(process.execPath,[path.join(__dirname,'launcher.cjs'),...process.argv.slice(3)],{env,stdio:'inherit',windowsHide:true});
child.on('error',()=>{console.error('dev-workflow: managed entry failed');process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
