const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseServers,failedNames,reconnectMcp,activeDirectories,reconnectAll}=require('../managed/mcp-reconnect.cjs');

const connected=(name)=>({name,status:{status:'connected'}});
const failed=(name)=>({name,status:{status:'failed',error:'MCP server process exited with code 255'}});

test('parseServers reads the OpenCode /api/mcp payload shape',()=>{
  const payload={location:{directory:'C:\\Users\\DHIKA'},data:[connected('playwright'),failed('dev-workflow')]};
  const servers=parseServers(payload);
  assert.deepEqual(servers,[
    {name:'playwright',state:'connected'},
    {name:'dev-workflow',state:'failed'},
  ]);
  assert.deepEqual(failedNames(servers),['dev-workflow']);
});

test('parseServers tolerates a bare array and a missing status',()=>{
  assert.deepEqual(parseServers([{name:'a',status:{status:'failed'}},{name:'b'}]),[
    {name:'a',state:'failed'},
    {name:'b',state:'unknown'},
  ]);
  assert.deepEqual(failedNames(parseServers(null)),[]);
});

test('connected servers are never reconnected',async()=>{
  const calls=[];
  const result=await reconnectMcp({
    directory:'C:\\Users\\DHIKA',
    read:async()=>({data:[connected('playwright'),connected('dev-workflow')]}),
    connect:async(name)=>calls.push(name),
    wait:async()=>{},
  });
  assert.deepEqual(calls,[]);
  assert.equal(result.ok,true);
  assert.deepEqual(result.healed,[]);
  assert.deepEqual(result.stillFailed,[]);
  assert.deepEqual(result.connected,['playwright','dev-workflow']);
});

test('a failed server is reconnected once and the reload succeeds when the status flips',async()=>{
  const calls=[];
  let round=0;
  const result=await reconnectMcp({
    directory:'H:\\\\work',
    read:async()=>({data:round++===0?[connected('playwright'),failed('dev-workflow')]:[connected('playwright'),connected('dev-workflow')]}),
    connect:async(name)=>calls.push(name),
    wait:async(ms)=>assert.ok(ms>=100),
    attempts:3,
  });
  assert.deepEqual(calls,['dev-workflow']);
  assert.equal(result.ok,true);
  assert.deepEqual(result.healed,['dev-workflow']);
  assert.deepEqual(result.stillFailed,[]);
  assert.deepEqual(result.connected,['playwright','dev-workflow']);
});

test('the reload reports failure when the server is still failed after the attempts',async()=>{
  const calls=[];
  const result=await reconnectMcp({
    directory:'/home/dhika',
    read:async()=>({data:[connected('playwright'),failed('dev-workflow')]}),
    connect:async(name)=>calls.push(name),
    wait:async()=>{},
    attempts:2,
  });
  assert.deepEqual(calls,['dev-workflow'],'the reconnect is attempted once, not once per poll');
  assert.equal(result.ok,false);
  assert.deepEqual(result.stillFailed,['dev-workflow']);
});

test('a rejected connect is reported instead of silently swallowed',async()=>{
  const logs=[];
  const result=await reconnectMcp({
    directory:'C:\\Users\\DHIKA',
    read:async()=>({data:[failed('dev-workflow')]}),
    connect:async()=>{throw new Error('opencode api returned 500');},
    wait:async()=>{},
    attempts:1,
    log:(line)=>logs.push(line),
  });
  assert.equal(result.ok,false);
  assert.deepEqual(result.stillFailed,['dev-workflow']);
  assert.match(logs.join('\n'),/opencode api returned 500/);
});

test('activeDirectories heals only projects OpenCode touched recently',()=>{
  const now=1_000_000_000;
  const projects=[
    {canonical:'C:\\Users\\DHIKA',time:{active:now-60_000}},
    {canonical:'D:\\code\\old',time:{active:now-48*60*60*1000}},
    {time:{active:now}},
    {canonical:'D:\\code\\fresh',time:{active:now-11*60*60*1000}},
  ];
  assert.deepEqual(activeDirectories(projects,{now,maxAgeMs:24*60*60*1000}),[
    'C:\\Users\\DHIKA',
    'D:\\code\\fresh',
  ]);
  assert.deepEqual(activeDirectories(null,{now}),[]);
});

test('reconnectAll heals every directory and reports the union of failures',async()=>{
  const seen=[];
  const result=await reconnectAll({
    directories:['C:\\Users\\DHIKA','D:\\code\\dev-workflow-mcp-server'],
    reconnect:async({directory})=>{
      seen.push(directory);
      return directory==='C:\\Users\\DHIKA'
        ? {ok:true,healed:['dev-workflow'],stillFailed:[],connected:['dev-workflow']}
        : {ok:false,healed:[],stillFailed:['dev-workflow'],connected:[]};
    },
  });
  assert.deepEqual(seen,['C:\\Users\\DHIKA','D:\\code\\dev-workflow-mcp-server']);
  assert.equal(result.ok,false);
  assert.deepEqual(result.stillFailed,['D:\\code\\dev-workflow-mcp-server:dev-workflow']);
  assert.equal(result.results.length,2);
});
