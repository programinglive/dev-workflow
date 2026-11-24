import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sentry from '../sentry-client.js';

const config={host:'https://sentry.io',organization:'example-org',token:'test-fixture-credential'};
const issue={id:'123',shortId:'APP-1',title:'Example exception',status:'unresolved',level:'error',permalink:'https://example-org.sentry.io/issues/123/',project:{id:'4',slug:'app',name:'Application'},count:'3',user:{email:'private@example.test'},request:{headers:{cookie:'private-cookie'}}};
test('configuration selects explicit environment or private config without accepting unsafe hosts',()=>{
 assert.equal(sentry.readSentryConfig({}),null);
 assert.deepEqual(sentry.readSentryConfig({SENTRY_ACCESS_TOKEN:config.token,SENTRY_ORG:'example-org'}),config);
 const directory=mkdtempSync(path.join(os.tmpdir(),'sentry-config-'));const file=path.join(directory,'sentry.env');
 writeFileSync(file,'SENTRY_ACCESS_TOKEN=test-fixture-credential\nSENTRY_ORG=example-org\nSENTRY_HOST=us.sentry.io\n');
 assert.equal(sentry.readSentryConfig({DEVWF_SENTRY_CONFIG:file}).host,'https://us.sentry.io');
 for(const host of ['http://sentry.io','https://sentry.io.attacker.test','https://user:pass@sentry.io','https://sentry.io/other','https://sentry.io?next=bad'])assert.equal(sentry.readSentryConfig({SENTRY_ACCESS_TOKEN:config.token,SENTRY_ORG:'example-org',SENTRY_HOST:host}),null);
 assert.equal(sentry.readSentryConfig({SENTRY_ACCESS_TOKEN:config.token,SENTRY_ORG:'../wrong'}),null);
});
test('list and retrieve use bounded organization routes and never return raw event fields',async()=>{
 const calls=[];
 const client=sentry.createSentryClient(config,{fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('/issues/123/')?issue:[issue]));}});
 const rows=await client.listIssues({query:'is:unresolved',limit:7,project:'4'});
 assert.equal(rows.length,1);assert.equal(rows[0].id,'123');assert.equal(rows[0].project.slug,'app');
 assert.equal(rows[0].user,undefined);assert.equal(rows[0].request,undefined);
 assert.equal(new URL(calls[0].url).searchParams.get('limit'),'7');
 assert.equal(new URL(calls[0].url).pathname,'/api/0/organizations/example-org/issues/');
 assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');
 assert.equal((await client.getIssue('123')).id,'123');
 assert.equal(calls[1].url,'https://sentry.io/api/0/organizations/example-org/issues/123/');
});
test('invalid inputs fail before network and provider error bodies stay private',async()=>{
 let requests=0;const client=sentry.createSentryClient(config,{fetchImpl:async()=>{requests++;return new Response('private-provider-body',{status:401});}});
 for(const value of ['../user','https://attacker.test','12?x=1',''])await assert.rejects(()=>client.getIssue(value),/issue ID/i);
 for(const limit of [0,101,1.5])await assert.rejects(()=>client.listIssues({limit}),/limit/i);
 assert.equal(requests,0);
 await assert.rejects(()=>client.getIssue('123'),error=>error.status===401&&!error.message.includes('private-provider-body'));
});
test('malformed oversized redirected and timed-out responses fail with sanitized errors',async()=>{
 const implementations=[async()=>new Response('not-json'),async()=>new Response(' '.repeat(1024*1024+1)),async()=>new Response('{}',{status:302,headers:{location:'https://attacker.test'}}),async()=>{throw Error('Bearer secret-provider-detail');}];
 for(const fetchImpl of implementations)await assert.rejects(()=>sentry.createSentryClient(config,{fetchImpl}).listIssues({}),error=>!error.message.includes('secret-provider-detail'));
 const client=sentry.createSentryClient(config,{timeoutMs:5,fetchImpl:async(_,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true});setTimeout(()=>resolve(new Response('[]')),25);})});
 await assert.rejects(()=>client.listIssues({}),/unavailable/i);
});
test('mismatched issue identities and unsupported list shapes are rejected',async()=>{
 await assert.rejects(()=>sentry.createSentryClient(config,{fetchImpl:async()=>new Response(JSON.stringify({...issue,id:'999'}))}).getIssue('123'),/invalid/i);
 await assert.rejects(()=>sentry.createSentryClient(config,{fetchImpl:async()=>new Response('{}')}).listIssues({}),/invalid/i);
});
test('cursor pages preserve continuation and inventory covers every accessible project',async()=>{
 const urls=[];const second={...issue,id:'124',shortId:'APP-2'};
 const client=sentry.createSentryClient(config,{fetchImpl:async url=>{
  urls.push(new URL(url));
  if(url.includes('/projects/'))return new Response(JSON.stringify([{id:'4',slug:'app',name:'Application'},{id:'5',slug:'quiet',name:'Quiet project'}]));
  const cursor=new URL(url).searchParams.get('cursor');
  return new Response(JSON.stringify(cursor?[second]:[issue]),{headers:{'X-Hits':'2',Link:cursor?'': '<https://sentry.io/api/0/organizations/example-org/issues/?cursor=next:0:0>; rel="next"; results="true"; cursor="next:0:0"'}});
 }});
 const page=await client.listIssuePage({limit:1});assert.equal(page.nextCursor,'next:0:0');assert.equal(page.hasMore,true);
 const result=await client.inventoryIssues({maxPages:5,statsPeriod:'90d'});
 assert.equal(result.complete,true);assert.equal(result.issues.length,2);assert.equal(result.projects.length,2);assert.equal(result.projects.find(p=>p.slug==='quiet').issueCount,0);
 assert.equal(result.scope.statsPeriod,'90d');assert.equal(result.scope.query,'is:unresolved');assert.equal(result.scope.project,'all_accessible');
 assert.ok(urls.some(url=>url.searchParams.get('cursor')==='next:0:0'));
});
test('an unfinished or inconsistent inventory cannot claim complete coverage',async()=>{
 const client=sentry.createSentryClient(config,{fetchImpl:async url=>url.includes('/projects/')?new Response(JSON.stringify([{id:'4',slug:'app'}])):new Response(JSON.stringify([issue]),{headers:{'X-Hits':'5',Link:'<https://sentry.io/next>; rel="next"; results="true"; cursor="next:0:0"'}})});
 const result=await client.inventoryIssues({maxPages:1});assert.equal(result.complete,false);assert.equal(result.nextCursor,'next:0:0');assert.equal(result.issues.length,1);
 await assert.rejects(()=>client.inventoryIssues({maxPages:0}),/page/i);
 await assert.rejects(()=>client.listIssuePage({cursor:'https://attacker.test'}),/cursor/i);
 await assert.rejects(()=>client.inventoryIssues({statsPeriod:'forever'}),/period/i);
});
test('overlapping pages or changing provider counts cannot silently produce complete coverage',async()=>{
 for(const mode of ['duplicate-issues','changing-counts','duplicate-projects']){
  const client=sentry.createSentryClient(config,{fetchImpl:async url=>{
   const next=new URL(url).searchParams.has('cursor');
   if(url.includes('/projects/'))return new Response(JSON.stringify(mode==='duplicate-projects'?[{id:'4',slug:'app'},{id:'4',slug:'app'}]:[{id:'4',slug:'app'}]));
   return new Response(JSON.stringify([next&&mode==='changing-counts'?{...issue,id:'124'}:issue]),{headers:{...(mode==='changing-counts'?{'X-Hits':next?'2':'3'}:{}),Link:next?'':'<https://sentry.io/next>; rel="next"; results="true"; cursor="next:0:0"'}});
  }});
  const result=await client.inventoryIssues({maxPages:5});assert.equal(result.complete,false,mode);assert.ok(result.inconsistencies.length>0);
 }
});
test('resolveIssue updates issue status via bounded organization PUT route and validates inputs',async()=>{
 const calls=[];
 const client=sentry.createSentryClient(config,{fetchImpl:async(url,options)=>{
  calls.push({url,options,body:options.body?JSON.parse(options.body):null});
  return new Response(JSON.stringify({...issue,status:JSON.parse(options.body).status}));
 }});
 const resolved=await client.resolveIssue('123');
 assert.equal(resolved.id,'123');
 assert.equal(resolved.status,'resolved');
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://sentry.io/api/0/organizations/example-org/issues/123/');
 assert.equal(calls[0].options.method,'PUT');
 assert.deepEqual(calls[0].body,{status:'resolved'});
 const ignored=await client.resolveIssue('123',{status:'ignored'});
 assert.equal(ignored.status,'ignored');
 await assert.rejects(()=>client.resolveIssue('../bad'),/issue ID/i);
 await assert.rejects(()=>client.resolveIssue('123',{status:'invalid'}),/status/i);
});
