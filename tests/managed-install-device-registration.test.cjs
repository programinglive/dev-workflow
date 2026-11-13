const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

// Regression guard: a zero-byte Antigravity CLI config left every MCP server
// unloaded, so tasks never reached the monitor while fleet checks stayed green.
const script=path.resolve(__dirname,'../managed/install-device.py');
const python=process.platform==='win32'?'python':'python3';

function runPython(body){
  const code=`import importlib.util,json,pathlib,tempfile
s=importlib.util.spec_from_file_location('install_device',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
home=pathlib.Path(tempfile.mkdtemp())
def put(rel,text):
    f=home/rel;f.parent.mkdir(parents=True,exist_ok=True);f.write_text(text,encoding='utf-8');return f
${body}
print('verified')`;
  const result=spawnSync(python,['-c',code],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}

test('inspect_registration distinguishes missing, empty, invalid, no-entry and ok configs',()=>{
  runPython(`
assert m.inspect_registration(home/'absent.json')[0]=='missing'
assert m.inspect_registration(put('empty.json',''))[0]=='empty'
assert m.inspect_registration(put('blank.json','  \\n'))[0]=='empty'
assert m.inspect_registration(put('bad.json','{"mcpServers":'))[0]=='invalid'
assert m.inspect_registration(put('list.json','[]'))[0]=='invalid'
assert m.inspect_registration(put('other.json','{"mcpServers":{"playwright":{"command":"npx"}}}'))[0]=='no-entry'
state,_,record=m.inspect_registration(put('ok.json','{"mcpServers":{"dev-workflow":{"command":"node","args":["x"]}}}'))
assert state=='ok' and record['command']=='node'
`);
});

test('client_config_files covers both Antigravity IDE and CLI paths',()=>{
  runPython(`
files={c:str(f).replace('\\\\','/') for c,f in m.client_config_files(home)}
assert files['antigravity'].endswith('.gemini/antigravity/mcp_config.json')
assert files['antigravity-cli'].endswith('.gemini/config/mcp_config.json')
`);
});

test('doctor flags an empty Antigravity CLI config and passes once registered',()=>{
  runPython(`
put('.gemini/config/mcp_config.json','')
report=m.doctor(home)
assert report['ok'] is False
cli=[r for r in report['registrations'] if r['client']=='antigravity-cli'][0]
assert cli['state']=='empty'
missing=[r for r in report['registrations'] if r['client']=='opencode']
assert all(r['state']=='missing' for r in missing)
put('.gemini/config/mcp_config.json','{"mcpServers":{"dev-workflow":{"command":"node","args":["e.cjs","antigravity"]}}}')
assert m.doctor(home)['ok'] is True
`);
});

test('install skips empty or invalid client configs without overwriting them and rewrites the CLI entry with antigravity schema',()=>{
  runPython(`
src=pathlib.Path(tempfile.mkdtemp())
for n in ('launcher.cjs','protocol.cjs','device-entry.cjs'):(src/n).write_text('',encoding='utf-8')
empty=put('.gemini/antigravity/mcp_config.json','')
cli=put('.gemini/config/mcp_config.json',json.dumps({'mcpServers':{'dev-workflow':{'command':'node','args':['old.js'],'env':{'KEEP':'test-only'}},'playwright':{'command':'npx','args':['keep']}}}))
import os
os.environ['LOCALAPPDATA']=str(home/'local')
result=m.install(home,src,node='node',verify=False)
assert empty.read_text(encoding='utf-8')=='', 'empty config must not be overwritten'
assert {'file':str(empty),'state':'empty'} in result['skipped']
data=json.loads(cli.read_text(encoding='utf-8'))
entry=data['mcpServers']['dev-workflow']
assert entry['command']=='node' and entry['args'][-1]=='antigravity' and entry['args'][0].endswith('device-entry.cjs')
assert entry['env']=={'KEEP':'test-only'}
assert data['mcpServers']['playwright']=={'command':'npx','args':['keep']}
assert str(cli) in result['changed']
`);
});
