import {readFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {registerRuntimeSecret} from './security/runtime-secrets.js';
const execFileAsync=promisify(execFile);

export function zettlySyncEnabled(env=process.env) {
  const flag=String(env.DEVWF_ZETTLY_SYNC||'').toLowerCase();
  if(['0','false','off'].includes(flag)) return false;
  // Test workers never use a workstation's real credentials by default.
  return !env.NODE_TEST_CONTEXT||['1','true','on'].includes(flag);
}

export function readZettlyConfig(env=process.env) {
  const file=env.DEVWF_ZETTLY_CONFIG||path.join(env.LOCALAPPDATA||os.homedir(),'DailyActivityJournal','config.env');
  const values={};
  try {
    for(const line of readFileSync(file,'utf8').split(/\r?\n/)) {
      const match=/^\s*(ZETTLY_API_BASE|ZETTLY_CLI_TOKEN)\s*=\s*(.*?)\s*$/.exec(line);
      if(match) values[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
    }
  } catch { /* Missing configuration is reported by the workflow integration. */ }
  const base=String(env.ZETTLY_API_BASE||values.ZETTLY_API_BASE||'').replace(/\/+$/,'').replace(/\/api\/v1$/,'');
  const token=String(env.ZETTLY_API_TOKEN||env.ZETTLY_CLI_TOKEN||values.ZETTLY_CLI_TOKEN||'');
  if(!base||!token) return null;
  let url;
  try {url=new URL(base);} catch {return null;}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) return null;
  registerRuntimeSecret(token);
  return {base,token};
}

async function readWindowsDpapiToken(file) {
  const literal="'"+file.replaceAll("'","''")+"'";
  const script=`$s=Get-Content -Raw -LiteralPath ${literal} | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}`;
  const modulePath=[path.join(process.env.WINDIR||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules'),path.join(process.env.ProgramFiles||'C:\\Program Files','WindowsPowerShell','Modules')].join(';');
  const result=await execFileAsync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:4096,env:{...process.env,PSModulePath:modulePath}});
  return result.stdout.trim();
}

async function readMacKeychainToken({service,account}) {
  const result=await execFileAsync('/usr/bin/security',['find-generic-password','-s',service,'-a',account,'-w'],{timeout:5000,maxBuffer:4096});
  return result.stdout.trim();
}

export async function resolveZettlyConfig(env=process.env,{platform=process.platform,home=os.homedir(),dpapiReader=readWindowsDpapiToken,keychainReader=readMacKeychainToken}={}) {
  let fallback=readZettlyConfig(env);
  let cli={};try{cli=JSON.parse(readFileSync(path.join(home,'.zettly','config.json'),'utf8'));}catch{}
  const base=env.ZETTLY_API_BASE||cli.host||fallback?.base||'https://zettly.programinglive.com';
  const owner=cli.managedOwnerCredential||{};
  const requestedOwner=env.ZETTLY_EXPECTED_USER_ID||owner.expectedUserId;
  const expectedUserId=requestedOwner?Number(requestedOwner):undefined;
  if(requestedOwner&&(!Number.isSafeInteger(expectedUserId)||expectedUserId<1))return null;
  if(env.ZETTLY_API_TOKEN&&fallback)return {...fallback,source:'environment',expectedUserId};
  if(platform==='win32'){
    const file=path.join(home,'.zettly','token.dpapi');
    try{
      const token=await dpapiReader(file);
      if(token){const config=readZettlyConfig({...env,ZETTLY_API_BASE:base,ZETTLY_API_TOKEN:token});return config?{...config,source:'windows-dpapi',expectedUserId}:null;}
    }catch{
      // A locked or inaccessible owner credential must not silently switch to
      // the old journal service account on the same device.
      if(existsSync(file))return null;
    }
  }
  if(platform==='darwin'&&owner.source==='macos-keychain'){
    try{
      const token=await keychainReader({service:owner.service||'programinglive.zettly',account:owner.account||'zettly-owner'});
      const config=token&&readZettlyConfig({...env,ZETTLY_API_BASE:base,ZETTLY_API_TOKEN:token});
      return config?{...config,source:'macos-keychain',expectedUserId}:null;
    }catch{return null;}
  }
  const verifiedFallback=env.ZETTLY_CLI_TOKEN||expectedUserId||env.DEVWF_ZETTLY_ALLOW_LEGACY_CONFIG==='1';
  return fallback&&verifiedFallback?{...fallback,source:'local-config',expectedUserId}:null;
}

export function createZettlyClient(config,{fetchImpl=fetch,timeoutMs=8000}={}) {
  let ownerCheck;
  async function request(method,route,body) {
    if(!/^\/(?:user|todos(?:\/\d+)?|focus(?:\/(?:current|[1-9]\d*(?:\/complete)?))?|journal\/entries)(?:\?[^#]*)?$/.test(route)) throw new Error('Use a supported relative Zettly API path');
    let response;
    try {
      response=await fetchImpl(config.base+'/api/v1'+route,{method,redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{authorization:`Bearer ${config.token}`,accept:'application/json','content-type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
    } catch {throw Object.assign(new Error('Zettly service unavailable'),{uncertain:method==='POST'});}
    if(!response.ok) throw Object.assign(new Error(`Zettly HTTP ${response.status}`),{status:response.status,uncertain:method==='POST'&&response.status>=500});
    try {
      const chunks=[];let bytes=0;
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw new Error('Response too large');chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(value?.success===false) throw new Error('Request was not accepted');
      return value;
    } catch {throw Object.assign(new Error('Invalid Zettly response'),{uncertain:method==='POST'});}
  }
  return {async request(method,route,body){
    if(config.expectedUserId&&method!=='GET'){
      ownerCheck||=request('GET','/user');
      const response=await ownerCheck;
      const user=response.data||response;
      if(Number(user.id)!==Number(config.expectedUserId))throw Object.assign(new Error('Zettly account does not match the configured owner'),{status:403,code:'ZETTLY_ACCOUNT_MISMATCH'});
    }
    return request(method,route,body);
  }};
}
