import { isSecretReference, SecretReference } from './references.js';
import { runtimeSecretSpans,prepareRuntimeSecretScan } from './runtime-secrets.js';

export const REDACTED = '[REDACTED]';
const sensitiveName = /(?:^|[_\-.])(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|session|credential|private[_-]?key|connection[_-]?string)(?:$|[_\-.])/i;
/**
 * A workload's session identifier is a routing key, not a credential.
 *
 * `checkpoint.handover.sessionKey` records which MCP session is being handed
 * off. Knowing it grants nothing without the state directory and the process,
 * so refusing to persist the checkpoint loses the handoff for no safety gain.
 * Only the exact identifier names are exempt: `sessionToken` and `sessionSecret`
 * stay subject to the normal rules.
 */
const sessionIdentifierName=/^(?:sessionKey|session_key|sessionId|session_id)$/i;

export function isSensitiveKey(key) {
  if(/^(?:secret_type|secret_provider|provider|token_count)$/i.test(key)) return false;
  if(sessionIdentifierName.test(String(key))) return false;
  const normalized=String(key).replace(/([a-z])([A-Z])/g,'$1_$2');
  return sensitiveName.test(normalized) || /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DATABASE_URL|DEV_WORKFLOW_DB_URL|accessToken|refreshToken|clientSecret|passwordHash|set-cookie)$/i.test(key);
}
export function isSafeValue(value) {
  if(value && typeof value==='object' && typeof value.uri==='string' && Object.keys(value).every(k=>['uri','provider'].includes(k)) && isSecretReference(value.uri) && (!value.provider||value.provider===value.uri.split('://')[0])) return true;
  return value instanceof SecretReference || value === '' || value == null || typeof value === 'boolean' ||
    (typeof value === 'string' && (isSecretReference(value) || /^(?:\[REDACTED\]|\*{3,}|<[^<>\r\n]+>|\$\{[A-Z_][A-Z0-9_]*\})$/.test(value)));
}

export function isWorkflowSessionField(key,value) {
  return key==='session' && value && typeof value==='object' &&
    ['active','review','blocked','paused','completed','ended'].includes(value.state);
}

const patterns = [
  ['private_key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g],
  ['ssh_key', /\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-\S+)\s+[A-Za-z0-9+/=]{40,}(?:[^\r\n]*)/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['api_key', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{16,}|v1\.0-[A-Za-z0-9_-]{30,})\b/g],
  ['oauth_token', /\b(?:ya29\.[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\b/g],
  ['connection_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:([^\s@/]+)@/gid, 1],
  ['authorization', /\b(?:authorization|proxy-authorization)\s*["']?\s*[:=]\s*["']?((?:(?:Bearer|Basic|Token)\s+)?[^\r\n,"'}]+)/gid, 1],
  ['bearer_token', /\bBearer\s+([A-Za-z0-9_.~+\/-]+=*)/gid, 1],
  ['cookie', /\b(?:set-cookie|cookie)\s*["']?\s*[:=]\s*["']?([^\r\n"'}]+)/gid, 1],
  ['sensitive_assignment', /\b([A-Za-z_][\w.-]*(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|DATABASE_URL|SESSION)[\w.-]*|password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|access_token|refresh_token|session(?:_id)?)\s*["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;<>}]+))/gid, 'assignment'],
];

export function entropy(value) {
  const counts={}; for(const c of value) counts[c]=(counts[c]||0)+1;
  return Object.values(counts).reduce((sum,n)=>sum-(n/value.length)*Math.log2(n/value.length),0);
}

export function secretSpans(text) {
  if(isSecretReference(text)) return [];
  const references=[...text.matchAll(/\b[a-z-]+:\/\/[^\s,"'<>]+/g)].filter(m=>isSecretReference(m[0])).map(m=>[m.index,m.index+m[0].length]);
  const found=runtimeSecretSpans(text);
  for (const [type,re,group] of patterns) {
    re.lastIndex=0;
    for(const match of text.matchAll(re)) {
      const index=group==='assignment' ? [2,3,4].find(i=>match[i]!==undefined) : group;
      let start=index ? match.indices[index][0] : match.index;
      let end=index ? match.indices[index][1] : match.index+match[0].length;
      if(references.some(([a,b])=>match.index>=a && end<=b)) continue;
      const value=text.slice(start,end);
      if(type==='authorization' && /^(?:Bearer|Basic|Token)\s+\[REDACTED\]$/i.test(value)) continue;
      if(type==='sensitive_assignment' && /^(?:authorization|cookie)$/i.test(match[1])) continue;
      if (isSafeValue(value)) continue;
      if(type==='authorization' && /^(Bearer|Basic|Token)\s+/i.test(value)) start+=value.match(/^\S+\s+/)[0].length;
      found.push({start,end,type,severity:type==='private_key'?'critical':'high'});
    }
  }
  // Context-only entropy: avoid flagging commit hashes, IDs, URLs and arbitrary prose.
  for (const m of text.matchAll(/\b(?:key|credential)\s*[:=]\s*([A-Za-z0-9_+\/-]{24,})/gid)) {
    if(!isSafeValue(m[1]) && entropy(m[1])>=3.5) found.push({start:m.indices[1][0],end:m.indices[1][1],type:'high_entropy_credential',severity:'high'});
  }
  return found;
}

export function redactText(text) {
  const spans=secretSpans(text).sort((a,b)=>a.start-b.start || b.end-a.end);
  let out='',cursor=0;
  for(const span of spans) {
    if(span.end<=cursor) continue;
    if(span.start<cursor) {cursor=span.end; continue;}
    out+=text.slice(cursor,span.start)+REDACTED; cursor=span.end;
  }
  return out+text.slice(cursor);
}

export function scanSecrets(value) {
  prepareRuntimeSecretScan();
  const findings=[],seen=new WeakSet();
  const add=(type,location,severity='high')=>findings.push({type,location:redactText(location),severity,sanitized_preview:REDACTED,suggested_secret_ref:'env://REQUIRED_CREDENTIAL'});
  function visit(item,location='$',depth=0) {
    if(depth>64) { add('inspection_limit',location); return; }
    if(typeof item==='function' || typeof item==='symbol') {add('executable_knowledge',location);return;}
    if(typeof item==='string') {
      const trimmed=item.trim();
      if(trimmed.startsWith('{')||trimmed.startsWith('[')) {
        try {visit(JSON.parse(item),location,depth+1);return;} catch { /* scan text */ }
      }
      for(const span of secretSpans(item)) add(span.type,`${location}:line ${item.slice(0,span.start).split('\n').length}`,span.severity);
    } else if(item && typeof item==='object') {
      if(seen.has(item)) return; seen.add(item);
      const prototype=Object.getPrototypeOf(item);
      if(![Object.prototype,Array.prototype,Date.prototype,Error.prototype,SecretReference.prototype,null].includes(prototype)) add('unsupported_knowledge_type',location);
      if(item instanceof Error) visit(item.message,`${location}.message`,depth+1);
      for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        const childLocation=`${location}.${redactText(key)}`;
        visit(key,`${location}.[key]`,depth+1);
        if(!('value' in descriptor)) {add('uninspectable_property',childLocation);continue;}
        const child=descriptor.value;
        if(isSensitiveKey(key) && !isSafeValue(child) && !isWorkflowSessionField(key,child)) add('sensitive_field',childLocation);
        visit(child,childLocation,depth+1);
      }
    }
  }
  visit(value); return findings;
}
