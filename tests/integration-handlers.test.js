import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleIntegrationTool,prepareTaskSource} from '../tools/handler-modules/integration-handlers.js';
import {syncZettlyTask,closeZettlyTask} from '../zettly-workflow.js';
import {getToolList} from '../tools/definitions.js';
import {handleToolCall} from '../tools/handlers.js';
import {readWorkspace} from '../factory-client.js';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const issue={id:'123',shortId:'APP-1',title:'Example issue',permalink:'https://example.sentry.io/issues/123/',project:{slug:'app'}};
const factoryId='11111111-1111-4111-8111-111111111111';
function fixture(){
 const workflowState={state:{workflowTaskId:'task-connector-1',taskDescription:'Fix the source issue',projectDir:'/repo',currentPhase:'coding',zettly:{todoId:166},zettlyOutbox:[],plan:[],definitionOfDone:[]},async save(){return {verified:true};}};
 let todo={id:166,type:'todo',is_completed:false,description:'Owner context',title:'Owner task',related_todos:[{id:167}]};const outcomes=[];const calls=[];
 const note={id:167,type:'note',is_completed:false,title:'Prior decision',description:'Reuse the verified integration.',related_todos:[]};
 const zettly={async request(method,route,body){calls.push({method,route});if(route==='/user')return {data:{id:1}};if(route==='/todos?type=todo')return {data:[todo]};if(route==='/todos?type=note')return {data:[note]};if(route==='/todos/167')return {data:note};if(route.startsWith('/todos/')){if(method==='PATCH')todo={...todo,...body};return {data:todo};}if(route.startsWith('/journal/entries')){if(method==='POST'){const entry={...body,id:1};outcomes.push(entry);return {data:entry};}return {data:outcomes};}throw Error('Unexpected request');}};
 const sentry={organization:'example',async listIssues(){return [issue];},async getIssue(){return issue;}};
 const factory={async readWorkspace(){return {projects:[{id:'project-1'}],tasks:[]};},async findTask(id){return id===factoryId?{id,taskKey:'TASK-1',title:'Existing Factory work',projectName:'repo',description:'Workflow task: task-connector-1\nZettly Todo #166'}:null;}};
 return {workflowState,options:{env:{},zettly,sentry,factory},calls,outcomes,getTodo:()=>todo};
}
const text=result=>result.content.map(item=>item.text||'').join(' ');
test('the MCP catalog exposes service status, issue reads and explicit canonical linking',()=>{
 const catalog=getToolList();
 for(const name of ['get_integration_status','list_sentry_issues','get_sentry_issue','link_sentry_issue','link_factory_task','get_zettly_task_context'])assert.ok(catalog.some(tool=>tool.name===name),'Missing tool '+name);
 assert.ok(catalog.find(tool=>tool.name==='link_sentry_issue').inputSchema.required.includes('issueId'));
});
test('an existing Factory task can be linked without a Sentry issue or duplicate Todo',async()=>{
 const f=fixture();const result=await handleIntegrationTool('link_factory_task',{factoryTaskId:factoryId},f.workflowState,f.options);
 assert.ok(!result.isError,text(result));assert.equal(f.workflowState.state.zettly.externalLinks.factory.id,factoryId);
 await syncZettlyTask(f.workflowState,{env:{DEVWF_ZETTLY_SYNC:'1'},client:f.options.zettly,force:true});
 assert.match(f.getTodo().description,/TASK-1/);assert.equal(f.workflowState.state.zettly.todoId,166);
});
test('a visible but unrelated Factory task cannot be linked or later marked done',async()=>{
 const f=fixture();f.options.factory.findTask=async id=>({id,projectName:'another-repo',description:'Zettly Todo #999'});
 const result=await handleIntegrationTool('link_factory_task',{factoryTaskId:factoryId},f.workflowState,f.options);
 assert.equal(result.isError,true);assert.equal(f.workflowState.state.dodFactoryTaskId,undefined);assert.equal(f.workflowState.state.zettly.externalLinks,undefined);
});
test('Draw linking rejects a visible drawing from another Todo or workflow',async()=>{
 const f=fixture();
 f.options.zettly={async request(){return {drawing:{id:5,document:{document:{store:{'document:document':{meta:{zettlyTodoId:999,workflowTaskId:'other'}}}}}}};}};
 const result=await handleIntegrationTool('link_zettly_drawing',{drawingId:5},f.workflowState,f.options);
 assert.equal(result.isError,true);assert.equal(f.workflowState.state.zettly.externalLinks,undefined);
});
test('connection checks verify all three clients without returning credentials or project data',async()=>{
 const f=fixture();const result=await handleIntegrationTool('get_integration_status',{},f.workflowState,f.options);
 const data=JSON.parse(text(result));assert.equal(data.zettly.status,'connected');assert.equal(data.factory.status,'connected');assert.equal(data.sentry.status,'connected');
 assert.ok(!text(result).includes('project-1'));
});
test('missing or failing connections stay explicit and provider bodies never escape',async()=>{
 const result=await handleIntegrationTool('get_integration_status',{},null,{env:{},zettly:null,factory:null,sentry:{async listIssues(){throw Object.assign(Error('Bearer private-error-body'),{status:403});}}});
 const data=JSON.parse(text(result));assert.equal(data.zettly.status,'not_configured');assert.equal(data.factory.status,'not_configured');assert.equal(data.sentry.status,'unavailable');assert.equal(data.sentry.httpStatus,403);assert.ok(!text(result).includes('private-error-body'));
});
test('issue tools return bounded source context and cannot invoke mutations',async()=>{
 const f=fixture();assert.match(text(await handleIntegrationTool('list_sentry_issues',{},f.workflowState,f.options)),/APP-1/);
 assert.match(text(await handleIntegrationTool('get_sentry_issue',{issueId:'123'},f.workflowState,f.options)),/APP-1/);
 assert.equal(f.calls.length,0);
});
test('verified issue and existing Factory task link idempotently to the canonical Todo',async()=>{
 const f=fixture();const args={issueId:'123',factoryTaskId:factoryId};
 for(let i=0;i<2;i++){const r=await handleIntegrationTool('link_sentry_issue',args,f.workflowState,f.options);assert.ok(!r.isError);}
 const links=f.workflowState.state.zettly.externalLinks;
 assert.equal(links.sentry.issueId,'123');assert.equal(links.factory.id,factoryId);assert.equal(f.workflowState.state.zettly.todoId,166);
 await syncZettlyTask(f.workflowState,{env:{DEVWF_ZETTLY_SYNC:'1'},client:f.options.zettly,force:true});
 assert.match(f.getTodo().description,/Owner context/);assert.match(f.getTodo().description,/APP-1/);assert.match(f.getTodo().description,/TASK-1/);
 await closeZettlyTask(f.workflowState,'completed',{}, {env:{DEVWF_ZETTLY_SYNC:'1'},client:f.options.zettly});
 assert.match(f.outcomes[0].content,/APP-1/);assert.match(f.outcomes[0].content,/TASK-1/);
 assert.ok(!f.calls.some(call=>call.method==='POST'&&call.route==='/todos'));
});
test('missing tasks and ownership changes prevent link mutation or external writes',async()=>{
 const f=fixture();const previous=structuredClone(f.workflowState.state);
 assert.equal((await handleIntegrationTool('link_sentry_issue',{issueId:'123',factoryTaskId:'22222222-2222-4222-8222-222222222222'},f.workflowState,f.options)).isError,true);
 assert.deepEqual(f.workflowState.state,previous);
 f.options.sentry.getIssue=async()=>{f.workflowState.state={...previous,workflowTaskId:'other-task'};return issue;};
 assert.equal((await handleIntegrationTool('link_sentry_issue',{issueId:'123'},f.workflowState,f.options)).isError,true);
 assert.ok(!f.workflowState.state.zettly.externalLinks);assert.equal(f.calls.length,0);
});
test('unverified persistence rejects a link and restores the current task metadata',async()=>{
 const f=fixture();f.workflowState.save=async()=>({verified:false,conflict:true});
 assert.equal((await handleIntegrationTool('link_sentry_issue',{issueId:'123'},f.workflowState,f.options)).isError,true);
 assert.ok(!f.workflowState.state.zettly.externalLinks);assert.equal(f.calls.length,0);
});
test('MCP dispatch verifies the issue link and synchronizes its references into the same Todo',async()=>{
 const f=fixture();
 const response=await handleToolCall({request:{params:{name:'link_sentry_issue',arguments:{issueId:'123',factoryTaskId:factoryId}}},normalizeRequestArgs:args=>({args,error:null}),workflowState:f.workflowState,integrationOptions:f.options,zettlyOptions:{env:{DEVWF_ZETTLY_SYNC:'1'},client:f.options.zettly}});
 assert.ok(!response.isError,text(response));assert.match(f.getTodo().description,/APP-1/);assert.match(f.getTodo().description,/TASK-1/);
 assert.equal(f.workflowState.state.zettly.todoId,166);
});
test('connection status remains parseable and excludes the current task plan through actual MCP dispatch',async()=>{
 const f=fixture();f.workflowState.state.plan=[{id:'plan-1',text:'Private customer escalation',status:'open'}];
 const response=await handleToolCall({request:{params:{name:'get_integration_status',arguments:{}}},normalizeRequestArgs:args=>({args,error:null}),workflowState:f.workflowState,integrationOptions:f.options});
 const data=JSON.parse(text(response));assert.equal(data.factory.status,'connected');assert.ok(!text(response).includes('Private customer'));
});
test('Factory connectivity rejects a login page or missing workspace shape while allowing empty arrays',async()=>{
 const f=fixture();
 for(const body of ['<html>Login</html>','{}','{"error":"Please sign in"}']){
  f.options.factory={async readWorkspace(){return readWorkspace({url:'https://factory.example.test',token:'test-fixture-token'},async()=>new Response(body));}};
  const result=await handleIntegrationTool('get_integration_status',{},null,f.options);assert.equal(JSON.parse(text(result)).factory.status,'unavailable');
 }
 f.options.factory={async readWorkspace(){return {projects:[],tasks:[]};}};
 assert.equal(JSON.parse(text(await handleIntegrationTool('get_integration_status',{},null,f.options))).factory.status,'connected');
});
test('inventory saves every source identity and reports explicit coverage without dumping issue content',async()=>{
 const f=fixture();f.workflowState.stateFile=path.join(mkdtempSync(path.join(os.tmpdir(),'sentry-inventory-')),'state.json');
 f.options.sentry.inventoryIssues=async()=>({organization:'example',scope:{project:'all_accessible',query:'is:unresolved',statsPeriod:'90d'},complete:false,projects:[{id:'4',slug:'app',issueCount:1},{id:'5',slug:'quiet',issueCount:0}],issues:[issue],nextCursor:'next:0:0'});
 const result=await handleIntegrationTool('inventory_sentry_issues',{},f.workflowState,f.options);
 assert.ok(!result.isError,text(result));const data=JSON.parse(text(result));assert.equal(data.complete,false);assert.equal(data.issueCount,1);assert.equal(data.projectCount,2);
 const saved=JSON.parse(readFileSync(data.snapshotPath,'utf8'));assert.equal(saved.issues[0].id,'123');assert.equal(saved.nextCursor,'next:0:0');assert.ok(!text(result).includes('Example issue'));
});
test('the context tool reads linked notes and attaches only to the canonical active Todo',async()=>{
 const f=fixture();
 const result=await handleToolCall({request:{params:{name:'get_zettly_task_context',arguments:{todoId:166,depth:1,maxNodes:5}}},normalizeRequestArgs:args=>({args,error:null}),workflowState:f.workflowState,integrationOptions:f.options});
 assert.ok(!result.isError,text(result));const context=JSON.parse(text(result));assert.equal(context.nodes.length,2);assert.ok(context.nodes.some(node=>node.id===167));assert.equal(f.workflowState.state.zettlyContext.todoId,166);
 assert.ok(!f.calls.some(call=>call.method!=='GET'));
 assert.equal((await handleIntegrationTool('get_zettly_task_context',{todoId:167,attach:true},f.workflowState,f.options)).isError,true);
});
test('Sentry origin is verified before task replacement and Factory origin requires a real claim',async()=>{
 const f=fixture();const args={source:{system:'sentry',id:'123'},description:'Fix the verified issue'};
 const good=await prepareTaskSource(args,f.options);assert.equal(good.args.source.url,issue.permalink);assert.equal(good.args.verifiedSourceIssue.issueId,'123');
 f.options.sentry.getIssue=async()=>{throw Object.assign(Error('private-provider-body'),{status:404});};
 const failed=await prepareTaskSource(args,f.options);assert.equal(failed.response.isError,true);assert.ok(!text(failed.response).includes('private-provider-body'));
 assert.equal((await prepareTaskSource({source:{system:'factory',id:factoryId}},f.options)).response.isError,true);
 assert.equal(f.calls.length,0);
});
test('an in-flight context read cannot attach to a different canonical Todo after relinking',async()=>{
 const f=fixture();const request=f.options.zettly.request.bind(f.options.zettly);
 f.options.zettly.request=async(method,route,body)=>{const result=await request(method,route,body);if(route==='/todos/166')f.workflowState.state.zettly.todoId=167;return result;};
 const result=await handleIntegrationTool('get_zettly_task_context',{todoId:166,depth:1,maxNodes:5,attach:true},f.workflowState,f.options);
 assert.equal(result.isError,true);assert.equal(f.workflowState.state.zettly.todoId,167);assert.ok(!f.workflowState.state.zettlyContext);
});
