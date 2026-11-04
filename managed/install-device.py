#!/usr/bin/env python3
"""Install a stable bootstrap while preserving existing MCP environments.

No credential is printed or transferred to the release service. Verification
prewarms the approved runtime before any client command is changed.
"""
import argparse, ast, datetime, json, os, pathlib, re, shutil, subprocess, sys

def read_json(file):
    text=file.read_text(encoding='utf-8-sig')
    text=re.sub(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/',lambda m:'' if m.group().startswith(('//','/*')) else m.group(),text)
    return json.loads(re.sub(r',\s*([}\]])',r'\1',text))

def record_of(data):
    records=data.get('mcp',data.get('mcpServers',{}))
    if 'servers' in records: records=records['servers']
    return records.get('dev-workflow')

def args_span(body):
    match=re.search(r'(?m)^args[ \t]*=[ \t]*(\[)',body)
    if not match:return None
    start=match.start(1);depth=0;quote=None;escaped=False;comment=False
    for index in range(start,len(body)):
        char=body[index]
        if comment:
            if char=='\n':comment=False
            continue
        if quote:
            if quote=='"' and escaped:escaped=False
            elif quote=='"' and char=='\\':escaped=True
            elif char==quote:quote=None
            continue
        if char=='#':comment=True
        elif char in ('"',"'"):quote=char
        elif char=='[':depth+=1
        elif char==']':
            depth-=1
            if depth==0:return (start,index+1)
    raise ValueError('Unterminated Codex args array')

def rewrite_json_command(record,command,array_command):
    if array_command:
        record['command']=command
        record.pop('args',None)
    else:
        record['command']=command[0]
        record['args']=command[1:]

def replace_toml_args(text,args):
    pattern=r'(?ms)(^\[mcp_servers\.(?:dev-workflow|"dev-workflow")\]\s*\n)(.*?)(?=^\[|\Z)'
    found=re.search(pattern,text)
    if not found: raise ValueError('Codex dev-workflow section not found')
    body=found.group(2)
    value=json.dumps(args,ensure_ascii=False)
    span=args_span(body)
    if span:body=body[:span[0]]+value+body[span[1]:]
    else:body='args = '+value+'\n'+body
    result=text[:found.start(2)]+body+text[found.end(2):]
    try:import tomllib
    except ImportError:pass
    else:tomllib.loads(result)
    return result

def toml_environment(text):
    match=re.search(r'(?ms)^\[mcp_servers\.(?:dev-workflow|"dev-workflow")\.env\]\s*\n(.*?)(?=^\[|\Z)',text)
    result={}
    if not match:return result
    for line in match.group(1).splitlines():
        pair=re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$',line)
        if not pair:continue
        try:
            value=ast.literal_eval(pair.group(2))
            if isinstance(value,str):result[pair.group(1)]=value
        except (SyntaxError,ValueError):pass
    return result

def node_from_toml(text):
    section=re.search(r'(?ms)^\[mcp_servers\.(?:dev-workflow|"dev-workflow")\]\s*\n(.*?)(?=^\[|\Z)',text)
    if not section:return None
    match=re.search(r'''(?m)^command[ \t]*=[ \t]*("(?:\\.|[^"\\])*"|'[^']*')''',section.group(1))
    if not match:return None
    value=match.group(1)
    return value[1:-1] if value.startswith("'") else json.loads(value)

def backup_write(file,text):
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup=file.with_name(file.name+'.before-managed-'+stamp)
    shutil.copy2(file,backup)
    if os.name!='nt':backup.chmod(0o600)
    temporary=file.with_name(file.name+'.managed.tmp')
    temporary.write_text(text,encoding='utf-8')
    shutil.copymode(file,temporary)
    os.replace(str(temporary),str(file))

def install(home,source,node=None,verify=True):
    home=pathlib.Path(home)
    local=pathlib.Path(os.environ.get('LOCALAPPDATA',str(home/'AppData/Local'))) if os.name=='nt' else home/'.local/share'
    target=local/'ProgramingLive/ManagedMCP/bootstrap'
    target.mkdir(parents=True,exist_ok=True)
    for name in ('launcher.cjs','protocol.cjs','device-entry.cjs'):
        shutil.copy2(pathlib.Path(source)/name,target/name)
    json_files=[home/'.config/opencode/opencode.json',home/'.config/opencode/opencode.jsonc',home/'.gemini/antigravity/mcp_config.json']
    configurations=[]
    for file in json_files:
        if not file.exists():continue
        data=read_json(file)
        record=record_of(data)
        if isinstance(record,dict):configurations.append((file,data,record))
    codex=home/'.codex/config.toml'
    codex_text=codex.read_text(encoding='utf-8') if codex.exists() else ''
    if not node:
        node=node_from_toml(codex_text)
    if not node:
        for _,_,record in configurations:
            cmd=record.get('command')
            if isinstance(cmd,list) and cmd:node=cmd[0];break
    node=node or shutil.which('node')
    if not node:raise RuntimeError('Existing Node executable not found')
    env={**os.environ}
    for _,_,record in configurations:
        for key,value in record.get('environment',record.get('env',{})).items():
            if not isinstance(value,str):continue
            ref=re.fullmatch(r'\{env:([A-Za-z_][A-Za-z0-9_]*)\}',value)
            env.setdefault(key,os.environ.get(ref.group(1),'') if ref else value)
    env.update(toml_environment(codex_text))
    env['PATH']=str(pathlib.Path(node).parent)+os.pathsep+env.get('PATH','')
    resolved=None
    if verify:
        result=subprocess.run([node,str(target/'launcher.cjs'),'--resolve-only'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=420)
        if result.returncode:raise RuntimeError('Managed runtime prewarm failed: '+result.stderr[-1500:])
        resolved=json.loads(result.stdout)
    # Preserve workstation credential-loading wrappers, changing only their target.
    wrappers=[home/'DevWorkflowMCP/launch.cjs',home/'AppData/Local/DevWorkflowMCP/launch.cjs'] if os.name=='nt' else []
    wrapper=None
    for file in wrappers:
        if not file.exists():continue
        text=file.read_text(encoding='utf-8')
        if 'const serverPath = path.join(globalModules,' in text:
            updated=re.sub(r'(?m)^const serverPath = .*?;$',lambda _:'const serverPath = '+json.dumps(str(target/'launcher.cjs'))+';',text,count=1)
        elif '[path.join(serverRoot, "index.js")]' in text:
            updated=text.replace('[path.join(serverRoot, "index.js")]','['+json.dumps(str(target/'launcher.cjs'))+']',1)
        else:continue
        backup_write(file,updated);wrapper=file;break
    changed=[]
    if codex_text and '[mcp_servers.' in codex_text:
        if wrapper:
            existing=re.search(r'(?ms)^\[mcp_servers\.(?:dev-workflow|"dev-workflow")\]\s*\n(.*?)(?=^\[|\Z)',codex_text)
            # The MMCH shared wrapper takes a client argument; HELLOWORLD's
            # keyring wrapper has no positional client argument.
            args=[str(wrapper)]+(['codex'] if wrapper==home/'AppData/Local/DevWorkflowMCP/launch.cjs' else [])
        else:args=[str(target/'device-entry.cjs'),'codex']
        updated=replace_toml_args(codex_text,args)
        backup_write(codex,updated);changed.append(str(codex))
    for file,data,record in configurations:
        client='antigravity' if 'antigravity' in str(file) else 'opencode'
        if wrapper and 'AppData/Local/DevWorkflowMCP' in str(wrapper).replace('\\','/'):
            command=[node,str(wrapper),client]
        else:command=[node,str(target/'device-entry.cjs'),client]
        rewrite_json_command(record,command,'antigravity' not in str(file) and not isinstance(record.get('command'),str))
        backup_write(file,json.dumps(data,indent=2,ensure_ascii=False)+'\n');changed.append(str(file))
    return {'device':env.get('DEVWF_MACHINE',os.environ.get('COMPUTERNAME','Mac')),'node':node,'bootstrap':str(target),'revision':resolved and resolved['revision'],'runtimeRoot':resolved and resolved['runtimeRoot'],'changed':changed,'wrapper':str(wrapper) if wrapper else None}

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',default=str(pathlib.Path(__file__).parent))
    parser.add_argument('--node')
    args=parser.parse_args()
    try:print(json.dumps(install(pathlib.Path.home(),args.source,args.node)))
    except Exception as error:
        # Configuration values and subprocess environment are never dumped.
        print('Managed MCP setup failed: '+str(error),file=sys.stderr);sys.exit(1)
