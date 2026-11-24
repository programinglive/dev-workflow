/**
 * @zettly-code DWF-SENTRY-RESOLVE-001
 * @purpose Native Sentry organization API client supporting bounded issue queries, inventory snapshots, and issue status resolution.
 * @invariant Never expose raw event bodies, user PII, request headers/cookies, or provider error bodies; validate host, org slug, and numeric issue IDs fail-closed.
 */
import {readFileSync} from 'node:fs';
import {registerRuntimeSecret} from './security/runtime-secrets.js';
import {sanitize} from './security/sanitizer.js';

const HOSTS=new Set(['sentry.io','us.sentry.io','de.sentry.io']);
const slug=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
const id=value=>typeof value==='string'&&/^\d{1,30}$/.test(value);
const STATUSES=new Set(['resolved','unresolved','ignored']);
const bounded=(value,max=500)=>typeof value==='string'?value.slice(0,max):'';

export function readSentryConfig(env=process.env) {
 const values={};
 if(env.DEVWF_SENTRY_CONFIG)try{
  for(const line of readFileSync(env.DEVWF_SENTRY_CONFIG,'utf8').split(/\r?\n/)){
   const match=/^\s*(SENTRY_ACCESS_TOKEN|SENTRY_AUTH_TOKEN|SENTRY_ORG|SENTRY_HOST)\s*=\s*(.*?)\s*$/.exec(line);
   if(match)values[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
 }catch{return null;}
 const token=env.SENTRY_ACCESS_TOKEN||env.SENTRY_AUTH_TOKEN||values.SENTRY_ACCESS_TOKEN||values.SENTRY_AUTH_TOKEN;
 const organization=env.SENTRY_ORG||values.SENTRY_ORG;
 if(typeof token!=='string'||!token.trim()||/[\r\n]/.test(token)||!slug(organization))return null;
 const raw=env.SENTRY_HOST||values.SENTRY_HOST||'sentry.io';
 let url;try{url=new URL(raw.includes('://')?raw:'https://'+raw);}catch{return null;}
 if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/')return null;
 registerRuntimeSecret(token);
 return {host:url.origin,organization,token:token.trim()};
}

function summary(issue) {
 if(!issue||!id(String(issue.id||''))||typeof issue.title!=='string')throw Error('Invalid Sentry issue response');
 let permalink='';try{const url=new URL(issue.permalink);if(url.protocol==='https:'&&(url.hostname==='sentry.io'||url.hostname.endsWith('.sentry.io'))&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash)permalink=url.href;}catch{}
 return sanitize({id:String(issue.id),shortId:bounded(issue.shortId,100),title:bounded(issue.title),status:bounded(issue.status,40),level:bounded(issue.level,40),permalink,project:{id:bounded(String(issue.project?.id||''),30),slug:bounded(issue.project?.slug,100),name:bounded(issue.project?.name,200)},count:bounded(String(issue.count||''),30),firstSeen:bounded(issue.firstSeen,40),lastSeen:bounded(issue.lastSeen,40)});
}

export function createSentryClient(config,{fetchImpl=fetch,timeoutMs=8000}={}) {
 const checked=readSentryConfig({SENTRY_HOST:config?.host,SENTRY_ORG:config?.organization,SENTRY_ACCESS_TOKEN:config?.token});
 if(!checked)throw Error('Invalid Sentry configuration');
 async function get(route,query) {
  let response;
  try{
   const url=new URL(checked.host+'/api/0/organizations/'+checked.organization+'/'+route);
   for(const [key,value] of Object.entries(query||{}))if(value!==undefined)url.searchParams.set(key,String(value));
   response=await fetchImpl(url.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{authorization:'Bearer '+checked.token,accept:'application/json'}});
  }catch{throw Error('Sentry service unavailable');}
  if(!response.ok)throw Object.assign(Error('Sentry HTTP '+response.status),{status:response.status});
  try{
   const chunks=[];let size=0;
   for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw Error('Oversized response');chunks.push(chunk);}
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const next=(response.headers.get('link')||'').split(',').find(part=>/rel="next"/.test(part)&&/results="true"/.test(part));
   const nextCursor=next?.match(/cursor="([^"\r\n]+)"/)?.[1]||null;
   if(next&&(!nextCursor||!/^[A-Za-z0-9:_-]{1,200}$/.test(nextCursor)))throw Error('Invalid pagination');
   const hits=response.headers.get('x-hits');
   return {data,nextCursor,totalHits:hits!==null&&/^\d+$/.test(hits)?Number(hits):null};
  }catch{throw Error('Invalid Sentry response');}
 }
 async function listIssuePage({query='is:unresolved',limit=20,project,cursor,statsPeriod='90d'}={}){
   if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid Sentry limit: use 1–100');
   if(typeof query!=='string'||query.length>500)throw Error('Invalid Sentry query');
   if(project!==undefined&&!id(String(project)))throw Error('Invalid Sentry project ID');
   if(cursor!==undefined&&(typeof cursor!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(cursor)))throw Error('Invalid Sentry cursor');
   if(typeof statsPeriod!=='string'||!/^\d{1,3}[dhmw]$/.test(statsPeriod))throw Error('Invalid Sentry period');
   const {data,nextCursor,totalHits}=await get('issues/',{query,limit,project,cursor,statsPeriod,sort:'date'});
   if(!Array.isArray(data))throw Error('Invalid Sentry issue list response');
   return {issues:data.slice(0,limit).map(summary),nextCursor,hasMore:!!nextCursor,totalHits};
 }
 return {
  listIssuePage,
  async listIssues(options){return (await listIssuePage(options)).issues;},
  async inventoryIssues({query='is:unresolved',maxPages=100,statsPeriod='90d'}={}){
   if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100)throw Error('Invalid page budget: use 1–100');
   const startedAt=new Date().toISOString();
   const projects=new Map(),issues=new Map(),inconsistencies=new Set();
   let projectCursor,projectComplete=false;
   const projectCursors=new Set();
   for(let page=0;page<maxPages;page++){
    const result=await get('projects/',{per_page:100,cursor:projectCursor});
    if(!Array.isArray(result.data))throw Error('Invalid Sentry project list');
    for(const project of result.data){if(!id(String(project.id||''))||!slug(project.slug))throw Error('Invalid Sentry project');if(projects.has(String(project.id)))inconsistencies.add('duplicate_project_identity');projects.set(String(project.id),{id:String(project.id),slug:project.slug,issueCount:0});}
    projectCursor=result.nextCursor;
    if(!projectCursor){projectComplete=true;break;}
    if(projectCursors.has(projectCursor))break;
    projectCursors.add(projectCursor);
   }
   let nextCursor,issueComplete=false,totalHits=null,pages=0;
   const issueCursors=new Set();
   for(;pages<maxPages;pages++){
    const result=await listIssuePage({query,limit:100,cursor:nextCursor,statsPeriod});
    for(const item of result.issues){if(issues.has(item.id))inconsistencies.add('duplicate_issue_identity');issues.set(item.id,item);}
    if(result.totalHits!==null){if(totalHits!==null&&totalHits!==result.totalHits)inconsistencies.add('changing_provider_count');if(totalHits===null)totalHits=result.totalHits;}
    nextCursor=result.nextCursor;
    if(!nextCursor){issueComplete=true;pages++;break;}
    if(issueCursors.has(nextCursor))break;
    issueCursors.add(nextCursor);
   }
   const unknownProjects=new Set();
   for(const issue of issues.values()){const project=projects.get(issue.project.id);if(project)project.issueCount++;else unknownProjects.add(issue.project.id);}
   return {organization:checked.organization,scope:{project:'all_accessible',query,statsPeriod},startedAt,finishedAt:new Date().toISOString(),complete:projectComplete&&issueComplete&&unknownProjects.size===0&&inconsistencies.size===0&&(totalHits===null||issues.size===totalHits),projects:[...projects.values()],issues:[...issues.values()],totalHits,pages,nextCursor,projectCursor,unknownProjectIds:[...unknownProjects],inconsistencies:[...inconsistencies]};
  },
  async getIssue(issueId){
   if(!id(issueId))throw Error('Invalid Sentry issue ID');
   const result=summary((await get('issues/'+issueId+'/')).data);
   if(result.id!==issueId)throw Error('Invalid Sentry issue identity');
   return result;
  },
  async resolveIssue(issueId,{status='resolved'}={}){
   if(!id(issueId))throw Error('Invalid Sentry issue ID');
   if(typeof status!=='string'||!STATUSES.has(status))throw Error('Invalid Sentry status');
   let response;
   try{
    const url=new URL(checked.host+'/api/0/organizations/'+checked.organization+'/issues/'+issueId+'/');
    response=await fetchImpl(url.href,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{authorization:'Bearer '+checked.token,accept:'application/json','content-type':'application/json'},body:JSON.stringify({status})});
   }catch{throw Error('Sentry service unavailable');}
   if(!response.ok)throw Object.assign(Error('Sentry HTTP '+response.status),{status:response.status});
   let data;
   try{
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw Error('Oversized response');chunks.push(chunk);}
    data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   }catch{throw Error('Invalid Sentry response');}
   const result=summary(data);
   if(result.id!==issueId)throw Error('Invalid Sentry issue identity');
   return result;
  }
 };
}
