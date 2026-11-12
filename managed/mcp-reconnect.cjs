#!/usr/bin/env node
'use strict';

/**
 * Reconnect OpenCode MCP servers that a reload left in the failed state.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every fleet update force-kills the ManagedMCP node process. Windows reports
 * that kill as exit code 255 and OpenCode records it as a transport error, then
 * marks the server `failed` - and never retries. `opencode service restart`
 * usually re-establishes the connection, but when it does not, nothing in the
 * reload notices: the fleet table stays green while the session has no
 * dev-workflow tools. The operator's only recourse was to remember a manual
 * `POST /api/experimental/mcp/<name>/connect`.
 *
 * So the reload reads `/api/mcp` after the restart, reconnects only the servers
 * that report `failed`, re-reads the status, and fails loudly when one is still
 * down. A green table now means connected, not merely "ManagedMCP is running".
 *
 * Usage:
 *   node managed/mcp-reconnect.cjs --directory <project directory>
 *   node managed/mcp-reconnect.cjs --directory <dir> --attempts 5 --interval-ms 2000
 */

const {spawnSync}=require('node:child_process');

const DEFAULT_ATTEMPTS=3;
const DEFAULT_INTERVAL_MS=1000;
const DEFAULT_SINCE_HOURS=24;

/** Normalise the `/api/mcp` payload into `{name, state}` records. */
function parseServers(payload) {
  const list=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:[];
  return list
    .filter(entry=>entry&&typeof entry.name==='string')
    .map(entry=>({
      name:entry.name,
      state:typeof entry.status?.status==='string'?entry.status.status:'unknown',
    }));
}

/** Names that OpenCode itself reports as failed. Connected servers are kept out. */
function failedNames(servers) {
  return (Array.isArray(servers)?servers:[])
    .filter(entry=>entry&&entry.state==='failed')
    .map(entry=>entry.name);
}

/**
 * Project directories OpenCode touched within the window.
 *
 * `/api/mcp` is answered per location, so healing only the directory the reload
 * happened to run from would leave the real session broken. OpenCode already
 * records which directories have a live project, with the last activity time.
 */
function activeDirectories(projects,{now=Date.now(),maxAgeMs=24*60*60*1000}={}) {
  if(!Array.isArray(projects)) return [];
  return projects
    .filter(entry=>entry&&typeof entry.canonical==='string'&&entry.canonical)
    .filter(entry=>typeof entry.time?.active==='number'&&now-entry.time.active<=maxAgeMs)
    .map(entry=>entry.canonical);
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/**
 * Reconnect every failed server, then verify the status.
 *
 * All side effects are injected so the decision can be tested without a
 * running OpenCode service.
 */
async function reconnectMcp({
  directory,
  read,
  connect,
  wait=sleep,
  attempts=DEFAULT_ATTEMPTS,
  intervalMs=DEFAULT_INTERVAL_MS,
  log=line=>console.log(line),
}={}) {
  const readStatus=async()=>parseServers(await read());
  const connectedNames=list=>list.filter(entry=>entry.state==='connected').map(entry=>entry.name);

  const initial=await readStatus();
  const failed=failedNames(initial);
  const healed=[];
  if(failed.length===0) {
    return {ok:true,healed,stillFailed:[],connected:connectedNames(initial)};
  }
  for(const name of failed) {
    try {
      await connect(name);
      healed.push(name);
      log(`reconnect ${name} (${directory}): requested`);
    } catch(error) {
      log(`reconnect ${name} (${directory}) failed: ${error.message}`);
    }
  }
  let current=initial;
  const rounds=Math.max(1,Number(attempts)||1);
  for(let round=1; round<=rounds; round+=1) {
    await wait(intervalMs);
    current=await readStatus();
    if(failedNames(current).length===0) break;
  }
  const stillFailed=failedNames(current);
  return {ok:stillFailed.length===0,healed,stillFailed,connected:connectedNames(current)};
}

/** Heal every directory and flatten the failures into `directory:server` lines. */
async function reconnectAll({directories,reconnect}) {
  const list=Array.isArray(directories)?directories:[];
  const results=[];
  const stillFailed=[];
  for(const directory of list) {
    const result=await reconnect({directory});
    results.push({directory,...result});
    for(const name of result.stillFailed||[]) stillFailed.push(`${directory}:${name}`);
  }
  return {ok:stillFailed.length===0&&results.every(result=>result.ok!==false),results,stillFailed};
}

function runOpc(args) {
  const options={
    encoding:'utf8',
    windowsHide:true,
    timeout:Number(process.env.DEVWF_RECONNECT_TIMEOUT_MS)||60000,
  };
  // On Windows the npm shim is a .cmd file, so it must run through cmd.exe.
  // Spawning it with shell:true instead would re-quote the URL and mangle the
  // encoded location parameter.
  const result=process.platform==='win32'
    ? spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',['opencode',...args].join(' ')],options)
    : spawnSync('opencode',args,options);
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error((result.stderr||result.stdout||`opencode exited ${result.status}`).trim());
  return result.stdout;
}

function directoryParam(directory) {
  // Percent-encoding must not be used here: the Windows shim runs through
  // cmd.exe, which expands %NAME% sequences and silently empties them.
  return `location[directory]=${directory}`;
}

function mcpPath(directory) {
  return `/api/mcp?${directoryParam(directory)}`;
}

function main(argv) {
  const directoryIndex=argv.indexOf('--directory');
  const explicitDirectory=directoryIndex>=0?argv[directoryIndex+1]:null;
  if(directoryIndex>=0&&!explicitDirectory) throw new Error('--directory requires a value');
  const attemptsIndex=argv.indexOf('--attempts');
  const attempts=attemptsIndex>=0?Number(argv[attemptsIndex+1])||DEFAULT_ATTEMPTS:DEFAULT_ATTEMPTS;
  const intervalIndex=argv.indexOf('--interval-ms');
  const intervalMs=intervalIndex>=0?Number(argv[intervalIndex+1])||DEFAULT_INTERVAL_MS:DEFAULT_INTERVAL_MS;
  const sinceIndex=argv.indexOf('--since-hours');
  const sinceHours=sinceIndex>=0?Number(argv[sinceIndex+1])||DEFAULT_SINCE_HOURS:DEFAULT_SINCE_HOURS;

  const read=async(directory)=>JSON.parse(runOpc(['api','get',mcpPath(directory)]));
  const connect=async(name,directory)=>{
    runOpc(['api','post',`/api/experimental/mcp/${name}/connect?${directoryParam(directory)}`]);
  };
  const heal=directory=>reconnectMcp({directory,read:()=>read(directory),connect:name=>connect(name,directory),attempts,intervalMs});

  if(explicitDirectory) {
    return heal(explicitDirectory).then(result=>{
      if(result.ok) {
        console.log(`  MCP       - connected: ${result.connected.join(', ')||'none'}`);
        return 0;
      }
      console.log(`  MCP       - ! still failed after reconnect: ${result.stillFailed.join(', ')}`);
      console.log(`  MCP       - run manually: opencode api post "/api/experimental/mcp/<name>/connect?location[directory]=${explicitDirectory}"`);
      return 1;
    });
  }

  const projects=JSON.parse(runOpc(['api','get','/api/project']));
  const directories=activeDirectories(projects,{maxAgeMs:sinceHours*60*60*1000});
  if(directories.length===0) {
    console.log(`  MCP       - no OpenCode project active in the last ${sinceHours}h; nothing to reconnect`);
    return Promise.resolve(0);
  }
  return reconnectAll({
    directories,
    reconnect:({directory})=>heal(directory),
  }).then(result=>{
    for(const entry of result.results) {
      const state=entry.ok?'connected':'still failed';
      console.log(`  MCP       - ${entry.directory}: ${state}${entry.stillFailed.length?` (${entry.stillFailed.join(', ')})`:''}`);
    }
    if(result.ok) return 0;
    console.log('  MCP       - ! reconnect verification failed; the reload is not finished');
    return 1;
  });
}

if(require.main===module) run();

/**
 * Entry point shared by the local script and the streamed remote run.
 *
 * Promise.resolve() first, so a synchronous throw inside main() is reported as
 * a message instead of escaping as an unhandled stack trace.
 */
function run() {
  return Promise.resolve()
    .then(()=>main(process.argv.slice(2)))
    .then(code=>{process.exitCode=code;})
    .catch(error=>{
      console.error(`  MCP       - ! reconnect check failed: ${error.message}`);
      process.exitCode=1;
    });
}

/**
 * Tail appended when this file is streamed to a remote `node -`.
 *
 * A program fed to `node -` never satisfies `require.main === module`, so the
 * guard above does not fire and the remote run exits silently with no output.
 * That looks exactly like a successful verification, which is the failure this
 * module exists to prevent. The reload appends this tail so the remote run has
 * an explicit entry point.
 */
const STDIN_RUNNER='\nrun();\n';

module.exports={parseServers,failedNames,reconnectMcp,activeDirectories,reconnectAll,STDIN_RUNNER,DEFAULT_ATTEMPTS,DEFAULT_INTERVAL_MS,DEFAULT_SINCE_HOURS};
