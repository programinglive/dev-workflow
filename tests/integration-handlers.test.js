import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleIntegrationTool,prepareTaskSource,autoResolveLinkedSentryIssue,checkErpSentryPreemption,isErpBackendProjectDir} from '../tools/handler-modules/integration-handlers.js';
import {handleCompleteTask} from '../tools/handler-modules/commit-handlers.js';
import {syncZettlyTask,closeZettlyTask} from '../zettly-workflow.js';
import {getToolList} from '../tools/definitions.js';
import {handleToolCall} from '../tools/handlers.js';
import {mkdtempSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const issue={id:'123',shortId:'APP-1',title:'Example issue',permalink:'https://example.sentry.io/issues/123/',project:{slug:'app'}};
function fixture(){
 const workflowState={state:{workflowTaskId:'task-connector-1',taskDescription:'Fix the source issue',projectDir:'/repo',currentPhase:'coding',zettly:{todoId:166},zettlyOutbox:[],plan:[],definitionOfDone:[]},async save(){return {verified:true};}};
 let todo={id:166,type:'todo',is_completed:false,description:'Owner context',title:'Owner task',related_todos:[{id:167}]};const outcomes=[];const calls=[];
 const note={id:167,type:'note',is_completed:false,title:'Prior decision',description:'Reuse the verified integration.',related_todos:[]};
 const zettly={async request(method,route,body){calls.push({method,route});if(route==='/user')return {data:{id:1}};if(route==='/todos?type=todo')return {data:[todo]};if(route==='/todos?type=note')return {data:[note]};if(route==='/todos/167')return {data:note};if(route.startsWith('/todos/')){if(method==='PATCH')todo={...todo,...body};return {data:todo};}if(route.startsWith('/journal/entries')){if(method==='POST'){const entry={...body,id:1};outcomes.push(entry);return {data:entry};}return {data:outcomes};}throw Error('Unexpected request');}};
 const sentry={organization:'example',resolvedCalls:[],async listIssues(){return [issue];},async getIssue(){return issue;},async resolveIssue(id,{status='resolved'}={}){this.resolvedCalls.push({id,status});return {...issue,id,status};}};
 return {workflowState,options:{env:{},zettly,sentry},calls,outcomes,getTodo:()=>todo};
}
const text=result=>result.content.map(item=>item.text||'').join(' ');
test('the MCP catalog exposes service status, issue reads and explicit canonical linking',()=>{
 const catalog=getToolList();
 for(const name of ['get_integration_status','list_sentry_issues','get_sentry_issue','link_sentry_issue','get_zettly_task_context'])assert.ok(catalog.some(tool=>tool.name===name),'Missing tool '+name);
 assert.ok(!catalog.some(tool=>/factory/i.test(tool.name)),'Factory sudah dipensiunkan, tool-nya tidak boleh terdaftar');
 assert.ok(catalog.find(tool=>tool.name==='link_sentry_issue').inputSchema.required.includes('issueId'));
});
test('Draw linking rejects a visible drawing from another Todo or workflow',async()=>{
 const f=fixture();
 f.options.zettly={async request(){return {drawing:{id:5,document:{document:{store:{'document:document':{meta:{zettlyTodoId:999,workflowTaskId:'other'}}}}}}};}};
 const result=await handleIntegrationTool('link_zettly_drawing',{drawingId:5},f.workflowState,f.options);
 assert.equal(result.isError,true);assert.equal(f.workflowState.state.zettly.externalLinks,undefined);
});
test('connection checks verify the configured clients without returning credentials or project data',async()=>{
 const f=fixture();const result=await handleIntegrationTool('get_integration_status',{},f.workflowState,f.options);
 const data=JSON.parse(text(result));assert.equal(data.zettly.status,'connected');assert.equal(data.sentry.status,'connected');
 assert.ok(!text(result).includes('project-1'));
});
test('missing or failing connections stay explicit and provider bodies never escape',async()=>{
 const result=await handleIntegrationTool('get_integration_status',{},null,{env:{},zettly:null,sentry:{async listIssues(){throw Object.assign(Error('Bearer private-error-body'),{status:403});}}});
 const data=JSON.parse(text(result));assert.equal(data.zettly.status,'not_configured');assert.equal(data.sentry.status,'unavailable');assert.equal(data.sentry.httpStatus,403);assert.ok(!text(result).includes('private-error-body'));
});
test('issue tools return bounded source context and cannot invoke mutations',async()=>{
 const f=fixture();assert.match(text(await handleIntegrationTool('list_sentry_issues',{},f.workflowState,f.options)),/APP-1/);
 assert.match(text(await handleIntegrationTool('get_sentry_issue',{issueId:'123'},f.workflowState,f.options)),/APP-1/);
 assert.equal(f.calls.length,0);
});
test('verified issue links idempotently to the canonical Todo',async()=>{
 const f=fixture();const args={issueId:'123'};
 for(let i=0;i<2;i++){const r=await handleIntegrationTool('link_sentry_issue',args,f.workflowState,f.options);assert.ok(!r.isError);}
 const links=f.workflowState.state.zettly.externalLinks;
 assert.equal(links.sentry.issueId,'123');assert.equal(f.workflowState.state.zettly.todoId,166);
 await syncZettlyTask(f.workflowState,{env:{DEVWF_ZETTLY_SYNC:'1'},client:f.options.zettly,force:true});
 assert.match(f.getTodo().description,/Owner context/);assert.match(f.getTodo().description,/APP-1/);
 await closeZettlyTask(f.workflowState,'completed',{}, {env:{DEVWF_ZETTLY_SYNC:'1'},client:f.options.zettly});
 assert.match(f.outcomes[0].content,/APP-1/);
 assert.ok(!f.calls.some(call=>call.method==='POST'&&call.route==='/todos'));
});
test('missing tasks and ownership changes prevent link mutation or external writes',async()=>{
 const missing=fixture();missing.workflowState.state.zettly={};
 const before=structuredClone(missing.workflowState.state);
 assert.equal((await handleIntegrationTool('link_sentry_issue',{issueId:'123'},missing.workflowState,missing.options)).isError,true);
 assert.deepEqual(missing.workflowState.state,before);assert.equal(missing.calls.length,0);
 const f=fixture();const previous=structuredClone(f.workflowState.state);
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
 const response=await handleToolCall({request:{params:{name:'link_sentry_issue',arguments:{issueId:'123'}}},normalizeRequestArgs:args=>({args,error:null}),workflowState:f.workflowState,integrationOptions:f.options,zettlyOptions:{env:{DEVWF_ZETTLY_SYNC:'1'},client:f.options.zettly}});
 assert.ok(!response.isError,text(response));assert.match(f.getTodo().description,/APP-1/);
 assert.equal(f.workflowState.state.zettly.todoId,166);
});
test('connection status remains parseable and excludes the current task plan through actual MCP dispatch',async()=>{
 const f=fixture();f.workflowState.state.plan=[{id:'plan-1',text:'Private customer escalation',status:'open'}];
 const response=await handleToolCall({request:{params:{name:'get_integration_status',arguments:{}}},normalizeRequestArgs:args=>({args,error:null}),workflowState:f.workflowState,integrationOptions:f.options});
 const data=JSON.parse(text(response));assert.ok(!('factory' in data),'Factory sudah dipensiunkan, status-nya tidak boleh dilaporkan');assert.ok(!text(response).includes('Private customer'));
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
test('Sentry origin is verified before task replacement',async()=>{
 const f=fixture();const args={source:{system:'sentry',id:'123'},description:'Fix the verified issue'};
 const good=await prepareTaskSource(args,f.options);assert.equal(good.args.source.url,issue.permalink);assert.equal(good.args.verifiedSourceIssue.issueId,'123');
 f.options.sentry.getIssue=async()=>{throw Object.assign(Error('private-provider-body'),{status:404});};
 const failed=await prepareTaskSource(args,f.options);assert.equal(failed.response.isError,true);assert.ok(!text(failed.response).includes('private-provider-body'));
 assert.equal(f.calls.length,0);
});
test('an in-flight context read cannot attach to a different canonical Todo after relinking',async()=>{
 const f=fixture();const request=f.options.zettly.request.bind(f.options.zettly);
 f.options.zettly.request=async(method,route,body)=>{const result=await request(method,route,body);if(route==='/todos/166')f.workflowState.state.zettly.todoId=167;return result;};
 const result=await handleIntegrationTool('get_zettly_task_context',{todoId:166,depth:1,maxNodes:5,attach:true},f.workflowState,f.options);
 assert.equal(result.isError,true);assert.equal(f.workflowState.state.zettly.todoId,167);assert.ok(!f.workflowState.state.zettlyContext);
});
test('link_sentry_issue with action=resolve updates Sentry status directly and records resolvedAt on matching task',async()=>{
 const f=fixture();
 const resolved=await handleIntegrationTool('link_sentry_issue',{issueId:'123',action:'resolve'},f.workflowState,f.options);
 assert.ok(!resolved.isError,text(resolved));
 assert.match(text(resolved),/status updated to 'resolved'/);
 assert.deepEqual(f.options.sentry.resolvedCalls,[{id:'123',status:'resolved'}]);
 assert.equal(f.workflowState.state.zettly.externalLinks.sentry.status,'resolved');
 assert.ok(f.workflowState.state.zettly.externalLinks.sentry.resolvedAt);
});
test('complete_task automatically resolves linked Sentry issues in Sentry before resetting task state',async()=>{
 const f=fixture();
 f.workflowState.state.dodRevision=0;
 f.workflowState.state.definitionOfDone=[{id:'dod-1',text:'Fix verified',status:'done',evidence:'npm test -> pass',revision:0}];
 f.workflowState.state.releaseSkipped=true;
 f.workflowState.state.zettly.externalLinks={sentry:{organization:'example',issueId:'123',shortId:'APP-1',url:issue.permalink}};
 f.workflowState.addToHistory=()=>{};
 f.workflowState.reset=()=>{f.workflowState.state={currentPhase:'idle'};};
 const res=await handleCompleteTask({commitMessage:'fix: resolve sentry issue APP-1',nextSteps:['Monitor Sentry']},f.workflowState,{integrationOptions:f.options,zettlyOptions:{env:{DEVWF_ZETTLY_SYNC:'0'}}});
 assert.match(text(res),/Sentry issue APP-1 \(123\) automatically marked as resolved/);
 assert.deepEqual(f.options.sentry.resolvedCalls,[{id:'123',status:'resolved'}]);
});
test('checkErpSentryPreemption blocks non-ERP start_task when unresolved project:erp issues exist, allows erp.beautyworld.co.id, and emits mid-task alerts',async()=>{
 const erpIssue={id:'7817922409',shortId:'ERP-63',title:'Allowed memory size exhausted on /report/getForecasting',permalink:'https://programinglive.sentry.io/issues/7817922409/',count:'25',project:{slug:'erp'}};
 const options={env:{},sentry:{organization:'programinglive',async listIssues(){return [erpIssue];}}};
 assert.equal(isErpBackendProjectDir('D:\\code\\erp.beautyworld.co.id'),true);
 assert.equal(isErpBackendProjectDir('D:\\code\\frontend_erp'),false);
 assert.equal(isErpBackendProjectDir('D:\\code\\clinic'),false);
 const blocked=await checkErpSentryPreemption({projectDir:'D:\\code\\clinic',mode:'start_task',options});
 assert.equal(blocked.preempted,true);
 assert.equal(blocked.response.isError,true);
 assert.match(text(blocked.response),/P0 ERP SENTRY PREEMPTION GATE/);
 assert.match(text(blocked.response),/ERP-63/);
 const allowedErp=await checkErpSentryPreemption({projectDir:'D:\\code\\erp.beautyworld.co.id',mode:'start_task',options});
 assert.equal(allowedErp.preempted,false);
 assert.equal(allowedErp.response,null);
 const allowedOverride=await checkErpSentryPreemption({projectDir:'D:\\code\\clinic',allowErpPreemptionOverride:true,mode:'start_task',options});
 assert.equal(allowedOverride.preempted,false);
 const midTask=await checkErpSentryPreemption({projectDir:'D:\\code\\clinic',mode:'status',options});
 assert.equal(midTask.preempted,true);
 assert.equal(midTask.response,null);
 assert.match(midTask.alertText,/P0 ERP SENTRY PREEMPTION ALERT/);
});
