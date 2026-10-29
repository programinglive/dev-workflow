// Node 20-compatible CommonJS bridge to the single ESM security implementation.
const pending=new Set();
let security;
const ready=Promise.all([import('./sanitizer.js'),import('./policy.js')]).then(([logging,policy])=>{security={...logging,...policy};});
function safeLog(level,...values) {
  const operation=ready.then(()=>security.safeLog(level,...values)).catch(()=>process.stderr.write('[REDACTED: logging unavailable]\n'));
  pending.add(operation); operation.finally(()=>pending.delete(operation));
}
async function flushLogs(){await Promise.all([...pending]);}
function assertSafeKnowledge(value){if(!security)throw new Error('Security initialization required; await log-bridge.ready');return security.assertSafeKnowledge(value);}
function spawnLogged(command,args,options={}) {
  const result=require('node:child_process').spawnSync(command,args,{...options,stdio:'pipe',encoding:'utf8',maxBuffer:16*1024*1024});
  if(result.stdout)safeLog('info',result.stdout);
  if(result.stderr)safeLog('error',result.stderr);
  return result;
}
module.exports={ready,safeLog,flushLogs,assertSafeKnowledge,spawnLogged};
