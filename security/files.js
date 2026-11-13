import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeKnowledge } from './policy.js';
import { sanitize } from './sanitizer.js';

export function isProtectedFile(file) {
  const normalized=String(file).replaceAll('\\','/').toLowerCase();
  const name=normalized.split('/').at(-1);
  return /^\.env(?:\.|$)/.test(name) || /^(?:credentials|service[-_]account).*\.json$/.test(name) ||
    /^(?:id_rsa|id_ed25519|id_dsa|id_ecdsa)(?:\.|$)/.test(name) || /\.(?:pem|key|p12|pfx)$/.test(name) ||
    /^(?:\.npmrc|\.git-credentials|\.netrc|_netrc|application_default_credentials\.json)$/.test(name) || normalized.includes('/.docker/') || normalized.includes('/.ssh/') || normalized.includes('/.aws/') || normalized.includes('/.kube/') || normalized.includes('/gcloud/');
}
export async function protectedFileMetadata(file) {
  const resolved=await fs.realpath(file);
  const stat=await fs.stat(resolved);
  return sanitize({path:file,protected:isProtectedFile(file)||isProtectedFile(resolved),size_bytes:stat.size,kind:stat.isFile()?'file':'directory',content:'[OMITTED]'});
}
export async function readKnowledgeFile(file) {
  const metadata=await protectedFileMetadata(file);
  if(metadata.protected) return metadata;
  // Refuse links entirely: do not race a link replacement between check and read.
  const stat=await fs.lstat(file);
  if(stat.isSymbolicLink() || !stat.isFile() || stat.size>1024*1024) throw new Error('Knowledge file is not an eligible regular file');
  const content=await fs.readFile(file,'utf8');
  assertSafeKnowledge({path:file,content});
  return {path:file,classification:'INTERNAL',content};
}
