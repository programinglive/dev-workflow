const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('device installer preserves Codex environment and other servers when replacing only workflow args',()=>{
 const script=path.resolve(__dirname,'../managed/install-device.py');
 const code=`import importlib.util,json
s=importlib.util.spec_from_file_location('install_device',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
text='[mcp_servers.dev-workflow]\\ncommand = "node"\\nargs = ["old/index.js"]\\n[mcp_servers.dev-workflow.env]\\nDEVWF_MONITOR_TOKEN = "test-secret"\\n[mcp_servers.other]\\nargs = ["unchanged"]\\n'
result=m.replace_toml_args(text,['managed/device-entry.cjs','codex'])
assert 'args = ["managed/device-entry.cjs", "codex"]' in result
assert '[mcp_servers.other]\\nargs = ["unchanged"]' in result
assert m.toml_environment(result)['DEVWF_MONITOR_TOKEN']=='test-secret'
assert m.record_of({'mcp':{'servers':{'dev-workflow':{'command':['node']}}}})['command']==['node']
print('verified')`;
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-c',code],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});

test('installer replaces complete multiline Codex args and preserves string-command client schemas',()=>{
 const script=path.resolve(__dirname,'../managed/install-device.py');
 const text='[mcp_servers.dev-workflow]\ncommand = "node"\nargs = [\n  "old/index.js",\n  "codex"\n]\n[mcp_servers.other]\nargs = ["keep"]\n';
 const code=`import importlib.util,json
s=importlib.util.spec_from_file_location('install_device',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
text=${JSON.stringify(text)}
result=m.replace_toml_args(text,['new/entry.cjs','codex'])
assert 'old/index.js' not in result
try:
 import tomllib
 assert tomllib.loads(result)['mcp_servers']['dev-workflow']['args']==['new/entry.cjs','codex']
except ImportError: pass
record={'command':'node','args':['old.js'],'env':{'KEEP':'test-only'}}
m.rewrite_json_command(record,['node','new/entry.cjs','antigravity'],False)
assert record=={'command':'node','args':['new/entry.cjs','antigravity'],'env':{'KEEP':'test-only'}}
record={'command':['node','old.js'],'environment':{'KEEP':'test-only'}}
m.rewrite_json_command(record,['node','new/entry.cjs','opencode'],True)
assert record['command']==['node','new/entry.cjs','opencode'] and 'args' not in record
`;
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-c',code],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});

test('Node detection is confined to workflow section and accepts TOML literal paths',()=>{
 const script=path.resolve(__dirname,'../managed/install-device.py');
 const text="[mcp_servers.dev-workflow]\ncommand = 'C:\\Program Files\\nodejs\\node.exe'\nargs = ['old.js']\n[hooks.other]\ncommand = \"unrelated-hook\"\n";
 const code=`import importlib.util
s=importlib.util.spec_from_file_location('install_device',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert m.node_from_toml(${JSON.stringify(text)})==${JSON.stringify('C:\\Program Files\\nodejs\\node.exe')}
`;
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-c',code],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
