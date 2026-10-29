import { scanSecrets } from './scanner.js';

export const CLASSIFICATIONS=Object.freeze(['PUBLIC','INTERNAL','CONFIDENTIAL','SECRET']);
export function securityMode(env=process.env) {
  const mode=env.DEV_WORKFLOW_SECURITY_MODE || 'strict';
  if(mode!=='strict') throw new Error('Only strict DEV_WORKFLOW_SECURITY_MODE is supported');
  return mode;
}
export function classify(value) {
  if(scanSecrets(value).length) return 'SECRET';
  let rank=value && typeof value==='object' && (value.classification || value.sensitivity) ? 0 : 1; const seen=new WeakSet();
  function visit(item) {
    if(typeof item==='string' && /^[\s]*[\[{]/.test(item)) {try{visit(JSON.parse(item));}catch{} return;}
    if(!item||typeof item!=='object'||seen.has(item)) return; seen.add(item);
    for(const key of ['classification','sensitivity']) {
      if(item[key]!==undefined) {
        const index=CLASSIFICATIONS.indexOf(String(item[key]).toUpperCase());
        if(index<0) throw new Error('Unknown knowledge classification');
        rank=Math.max(rank,index);
      }
    }
    for(const child of Object.values(item)) visit(child);
  }
  visit(value); return CLASSIFICATIONS[rank];
}
export class SecretContentError extends Error {
  constructor(findings=[]) {
    super('Secret content denied. Replace credential material with a SecretReference.');
    this.code='SECRET_CONTENT_DENIED'; this.findings=findings;
  }
}
export function assertSafeKnowledge(value) {
  securityMode();
  const findings=scanSecrets(value);
  if(findings.length || classify(value)==='SECRET') throw new SecretContentError(findings);
  return value;
}
