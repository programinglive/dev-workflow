import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readZettlyConfig,resolveZettlyConfig,createZettlyClient} from '../zettly-client.js';
import {sanitize} from '../security/sanitizer.js';

test('device-local owner credentials are registered for egress redaction without entering workflow data',()=>{
 const value='opaque-device-fixture-credential-for-redaction';
 const config=readZettlyConfig({ZETTLY_API_BASE:'https://zettly.example',ZETTLY_API_TOKEN:value});
 assert.equal(config.token,value);
 assert.ok(!JSON.stringify(sanitize({message:'Provider echoed '+value})).includes(value));
});

test('Zettly credentials use existing local config with environment overrides',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'zettly-config-test-'));
 try {
  const file=path.join(dir,'config.env');await writeFile(file,'ZETTLY_API_BASE=https://zettly.example/api/v1\nZETTLY_CLI_TOKEN=test-only-file-credential\n');
  const config=readZettlyConfig({DEVWF_ZETTLY_CONFIG:file,ZETTLY_CLI_TOKEN:'test-only-env-credential'});
  assert.equal(config.base,'https://zettly.example');assert.equal(config.token,'test-only-env-credential');
  assert.equal(readZettlyConfig({DEVWF_ZETTLY_CONFIG:path.join(dir,'missing')}),null);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('requests authenticate in memory and do not follow redirects',async()=>{
 let sent;
 const client=createZettlyClient({base:'https://zettly.example',token:'test-only-auth-value'},{fetchImpl:async(url,options)=>{sent={url,options};return new Response('{"success":true,"data":{"id":7}}',{status:200});}});
 const result=await client.request('PATCH','/todos/7',{description:'Progress'});
 assert.equal(result.data.id,7);assert.equal(sent.url,'https://zettly.example/api/v1/todos/7');
 assert.equal(sent.options.headers.authorization,'Bearer test-only-auth-value');assert.equal(sent.options.redirect,'error');
 await assert.rejects(client.request('GET','https://untrusted.example/'),/relative/);
});

test('focus API routes remain bounded to the managed Zettly host',async()=>{
 const routes=[];
 const client=createZettlyClient({base:'https://zettly.example',token:'test-only-auth-value'},{fetchImpl:async(url)=>{routes.push(url);return new Response('{"success":true,"data":[]}',{status:200});}});
 for(const [method,route] of [['GET','/focus'],['POST','/focus'],['GET','/focus/7'],['POST','/focus/7/complete']])await client.request(method,route,method==='POST'?{}:undefined);
 assert.ok(routes.every(url=>url.startsWith('https://zettly.example/api/v1/focus')));
 await assert.rejects(client.request('POST','/focus/7/other-operation',{}),/supported/);
});

test('network and HTTP errors expose safe status without credential text',async()=>{
 const client=createZettlyClient({base:'https://zettly.example',token:'test-only-auth-value'},{fetchImpl:async()=>{throw new Error('private diagnostic test-only-auth-value');}});
 await assert.rejects(client.request('POST','/todos',{title:'Test'}),error=>error.uncertain===true&&!error.message.includes('test-only-auth-value'));
 const denied=createZettlyClient({base:'https://zettly.example',token:'test-only-auth-value'},{fetchImpl:async()=>new Response('secret response',{status:401})});
 await assert.rejects(denied.request('POST','/todos',{}),error=>error.status===401&&!error.uncertain&&!error.message.includes('secret response'));
});

test('authenticated Zettly CLI account takes precedence over the legacy journal service credential',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'zettly-account-test-'));
 try {
  const file=path.join(dir,'config.env');await writeFile(file,'ZETTLY_API_BASE=https://zettly.example\nZETTLY_CLI_TOKEN=test-only-service-credential\n');
  const config=await resolveZettlyConfig({DEVWF_ZETTLY_CONFIG:file},{platform:'win32',home:dir,dpapiReader:async()=> 'test-only-owner-credential'});
  assert.equal(config.token,'test-only-owner-credential');assert.equal(config.source,'windows-dpapi');
  const explicit=await resolveZettlyConfig({DEVWF_ZETTLY_CONFIG:file,ZETTLY_API_TOKEN:'test-only-explicit-credential'},{platform:'win32',home:dir,dpapiReader:async()=>{throw new Error('Must not read CLI when explicitly configured');}});
  assert.equal(explicit.token,'test-only-explicit-credential');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('Mac owner credentials use Keychain and never fall back to a service account when locked',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'zettly-keychain-test-'));
 try {
  const file=path.join(dir,'legacy.env');await writeFile(file,'ZETTLY_API_BASE=https://zettly.example\nZETTLY_CLI_TOKEN=test-only-service-credential\n');
  await mkdir(path.join(dir,'.zettly'));await writeFile(path.join(dir,'.zettly/config.json'),JSON.stringify({host:'https://zettly.example',managedOwnerCredential:{source:'macos-keychain',service:'programinglive.zettly',account:'zettly-owner',expectedUserId:1}}));
  const config=await resolveZettlyConfig({DEVWF_ZETTLY_CONFIG:file},{platform:'darwin',home:dir,keychainReader:async()=> 'test-only-owner-credential'});
  assert.equal(config.token,'test-only-owner-credential');assert.equal(config.expectedUserId,1);
  const locked=await resolveZettlyConfig({DEVWF_ZETTLY_CONFIG:file},{platform:'darwin',home:dir,keychainReader:async()=>{throw new Error('Locked');}});
  assert.equal(locked,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('configured owner mismatch stops mutations before sending task content',async()=>{
 const methods=[];
 const client=createZettlyClient({base:'https://zettly.example',token:'test-only-credential',expectedUserId:1},{fetchImpl:async(url,options)=>{methods.push(options.method);return new Response('{"id":8}',{status:200});}});
 await assert.rejects(client.request('POST','/todos',{title:'Owner work'}),/account|owner/i);
 assert.deepEqual(methods,['GET']);
});

test('an unverified legacy journal credential is not selected for owner task creation',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'zettly-service-fallback-'));
 try{
  const file=path.join(dir,'legacy.env');await writeFile(file,'ZETTLY_API_BASE=https://zettly.example\nZETTLY_CLI_TOKEN=test-only-service-credential\n');
  assert.equal(await resolveZettlyConfig({DEVWF_ZETTLY_CONFIG:file},{platform:'linux',home:dir}),null);
  const checked=await resolveZettlyConfig({DEVWF_ZETTLY_CONFIG:file,ZETTLY_EXPECTED_USER_ID:'1'},{platform:'linux',home:dir});
  assert.equal(checked.expectedUserId,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('protected owner credentials stay paired with their CLI host instead of a legacy service host',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'zettly-origin-test-'));
 try{
  const file=path.join(dir,'legacy.env');await writeFile(file,'ZETTLY_API_BASE=https://legacy-service.example\nZETTLY_CLI_TOKEN=test-only-service-credential\n');
  await mkdir(path.join(dir,'.zettly'));await writeFile(path.join(dir,'.zettly/config.json'),JSON.stringify({host:'https://owner.example',managedOwnerCredential:{expectedUserId:1}}));
  const config=await resolveZettlyConfig({DEVWF_ZETTLY_CONFIG:file},{platform:'win32',home:dir,dpapiReader:async()=> 'test-only-owner-credential'});
  assert.equal(config.base,'https://owner.example');
 }finally{await rm(dir,{recursive:true,force:true});}
});
