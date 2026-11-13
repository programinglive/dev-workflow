import { REDACTED, redactText, isSensitiveKey, isSafeValue, isWorkflowSessionField } from './scanner.js';
import { redactRuntimeSecrets,prepareRuntimeSecretScan } from './runtime-secrets.js';

export function sanitize(value) {
  prepareRuntimeSecretScan();
  const seen=new WeakSet();
  function clean(item,depth=0) {
    if(depth>64) return '[OMITTED]';
    if(typeof item==='string') {
      const trimmed=item.trim();
      if(trimmed.startsWith('{')||trimmed.startsWith('[')) {
        try { return JSON.stringify(clean(JSON.parse(item),depth+1)); } catch { /* text */ }
      }
      return redactRuntimeSecrets(redactText(item));
    }
    if(typeof item==='bigint') return String(item);
    if(typeof item==='function'||typeof item==='symbol') return '[OMITTED]';
    if(item===null||typeof item!=='object') return item;
    if(seen.has(item)) return '[CIRCULAR]'; seen.add(item);
    if(item instanceof Date) return Date.prototype.toISOString.call(item);
    if(Buffer.isBuffer(item)||ArrayBuffer.isView(item)) return '[BINARY OMITTED]';
    if([item.classification,item.sensitivity].some(label=>label!==undefined && !['PUBLIC','INTERNAL','CONFIDENTIAL'].includes(String(label).toUpperCase()))) return {classification:'SECRET',content:REDACTED};
    if(item instanceof Error) return {name:'Error',message:clean(item.message,depth+1)};
    const out=Array.isArray(item)?[]:{};
    for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if(key==='length' && Array.isArray(item)) continue;
      const safeKey=redactRuntimeSecrets(redactText(key));
      const child='value' in descriptor ? descriptor.value : REDACTED;
      Object.defineProperty(out,safeKey,{value:isSensitiveKey(key)&&!isSafeValue(child)&&!isWorkflowSessionField(key,child)?REDACTED:clean(child,depth+1),enumerable:true,writable:true,configurable:true});
    }
    return out;
  }
  try {return clean(value);} catch {return '[REDACTED: inspection failed]';}
}

export const securityOutputFilter = sanitize;

export function safeLog(level,...values) {
  const last=values.at(-1);
  const sink=last && typeof last.write==='function' ? values.pop() : process.stderr;
  try {sink.write(JSON.stringify(sanitize({level,values}))+'\n');} catch {sink.write('[REDACTED: logging failed]\n');}
}
