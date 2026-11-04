import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('real MCP client accepts tool catalog with classification JSON schemas',{timeout:15000},async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const dir=mkdtempSync(path.join(os.tmpdir(),'mcp-catalog-'));
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'index.js')],stderr:'pipe',
  env:{...process.env,DEV_WORKFLOW_DB_TYPE:'sqlite',DEV_WORKFLOW_DB_PATH:path.join(dir,'state.db'),DEV_WORKFLOW_STATE_FILE:path.join(dir,'state.json'),DEV_WORKFLOW_NO_COMPAT_LINKS:'1',DEVWF_MONITOR_URL:''}});
 const client=new Client({name:'catalog-schema-regression',version:'1.0.0'});
 try {
  await client.connect(transport);
  transport.stderr?.resume();
  const result=await client.listTools();
  assert.match(client.getInstructions(),/English implementation rule/);
  assert.match(client.getInstructions(),/Zettly/);
  assert.ok(result.tools.some(tool=>tool.name==='sync_zettly_task'));
  const start=result.tools.find(tool=>tool.name==='start_task');
  assert.ok(start);
  assert.equal(start.inputSchema.properties.classification.type,'string');
  assert.ok(start.inputSchema.properties.classification.enum.includes('SECRET'));
  assert.equal(start.inputSchema.properties.description.type,'string');
 } finally {await client.close();rmSync(dir,{recursive:true,force:true});}
});
