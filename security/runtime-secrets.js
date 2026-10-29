// Runtime-only redaction memory. Never serialize this set or expose a resolver.
const material=new Set();
let scanValues=null;
export function registerRuntimeSecret(value) {
  if(typeof value==='string' && value.length>0) {
    material.add(value);
    scanValues=null;
    try{const url=new URL(value);if(url.password){material.add(url.password);material.add(decodeURIComponent(url.password));}}catch{}
  }
}
export function prepareRuntimeSecretScan() {
  // Environment is inspected locally, never returned/logged/stored. This also
  // covers opaque credential formats not recognized by provider patterns.
  const values=[...material];
  for(const [name,value] of Object.entries(process.env)) {
    if(/(?:PASSWORD|PASSWD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY|DATABASE_URL|DEV_WORKFLOW_DB_URL$)/i.test(name) && !/(?:_ENV|_MODE|_REF)$/.test(name) && value && !/^(?:env|op|vault|aws-secrets|gcp-secret|bitwarden):\/\//.test(value)) values.push(value);
  }
  scanValues=[...new Set(values)].sort((a,b)=>b.length-a.length);
}
export function runtimeSecretSpans(text) {
  const spans=[];
  if(!scanValues)prepareRuntimeSecretScan();
  for(const value of scanValues) if(value) {
    let offset=0,index;
    while((index=text.indexOf(value,offset))>=0) {
      const before=text[index-1]||'',after=text[index+value.length]||'';
      if(value.length>=8 || (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after))) spans.push({start:index,end:index+value.length,type:'known_runtime_credential',severity:'high'});
      offset=index+value.length;
    }
  }
  return spans;
}
export function redactRuntimeSecrets(text) {
  let out='',cursor=0;
  for(const span of runtimeSecretSpans(text).sort((a,b)=>a.start-b.start || b.end-a.end)) {
    if(span.end<=cursor)continue;
    if(span.start<cursor){cursor=span.end;continue;}
    out+=text.slice(cursor,span.start)+'[REDACTED]';cursor=span.end;
  }
  out+=text.slice(cursor);
  return out;
}
