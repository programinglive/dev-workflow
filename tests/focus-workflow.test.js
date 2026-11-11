import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleFocusTool,prepareTaskFocus} from '../focus-workflow.js';
import {getToolList} from '../tools/definitions.js';
import {buildTaskProvenance} from '../task-provenance.js';

function fixture() {
 let focuses=[{id:7,user_id:1,title:'Finish notifications',description:'Owner context',completed_at:null}];
 let todos=[{id:20,user_id:1,title:'Current work',description:'Existing owner description',is_completed:false}];
 const calls=[];
 const state={state:{workflowTaskId:'workflow-1',taskDescription:'Current work',currentPhase:'coding',zettly:{todoId:20},taskOrigin:{system:'sentry',id:'123'}},async save(){return {verified:true};}};
 const client={async request(method,route,body){calls.push({method,route,body});if(route==='/user')return {id:1,name:'Owner'};if(method==='GET'&&route==='/focus')return {data:structuredClone(focuses)};if(method==='GET'&&route==='/todos?type=todo')return {data:structuredClone(todos)};if(method==='GET'&&route==='/todos/20')return {data:structuredClone(todos[0])};if(method==='PATCH'&&route==='/todos/20'){todos[0]={...todos[0],...body};return {data:todos[0]};}if(method==='POST'&&route==='/focus'){const f={id:8,user_id:1,completed_at:null,...body};focuses.push(f);return {data:f};}if(method==='POST'&&route==='/focus/7/complete'){focuses[0].completed_at='2026-11-05T00:00:00Z';return {success:true,data:focuses[0]};}throw Error('Unexpected route');}};
 return {state,calls,client,options:{client,env:{},expectedUserId:1},setFocuses:v=>{focuses=v;},getTodos:()=>todos};
}
const data=r=>JSON.parse(r.content[0].text);

test('catalog exposes explicit focus lifecycle tools',()=>{
 for(const name of ['get_current_focus','set_focus','link_task_to_focus','complete_focus'])assert.ok(getToolList().some(t=>t.name===name));
});

test('current focus reports every active focus instead of refusing to choose',async()=>{
 const f=fixture();const r=data(await handleFocusTool('get_current_focus',{},f.state,f.options));assert.equal(r.owner.id,1);assert.equal(r.focus.id,7);assert.equal(r.activeFocusCount,1);
 f.setFocuses([{id:7,user_id:1,title:'One',completed_at:null},{id:8,user_id:1,title:'Two',completed_at:null}]);
 const many=await handleFocusTool('get_current_focus',{},f.state,f.options);assert.equal(many.isError,undefined);
 const view=data(many);assert.equal(view.activeFocusCount,2);assert.deepEqual(view.activeFoci.map(x=>x.id),[7,8]);assert.match(view.instruction,/focusId explicitly/);
});

test('expected browser owner mismatch stops reads and mutations before task data changes',async()=>{
 const f=fixture();const r=await handleFocusTool('set_focus',{title:'Other focus',expectedOwnerId:8},f.state,f.options);
 assert.equal(data(r).error,'FOCUS_OWNER_MISMATCH');assert.equal(f.calls.length,1);
});

test('a second focus can be opened beside an unfinished one and a repeated title is reused',async()=>{
 const f=fixture();
 const other=await handleFocusTool('set_focus',{title:'Unrelated work'},f.state,f.options);assert.equal(other.isError,undefined);assert.equal(data(other).created,true);
 assert.equal(data(await handleFocusTool('set_focus',{title:'Finish notifications'},f.state,f.options)).focus.id,7);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.route==='/focus').length,1);
});

test('missing focus can be created and is read back before success',async()=>{
 const f=fixture();f.setFocuses([]);const r=await handleFocusTool('set_focus',{title:'New focus'},f.state,f.options);
 assert.equal(r.isError,undefined);assert.equal(data(r).focus.id,8);
});

test('link preserves owner content and source identity while adding focus relation',async()=>{
 const f=fixture();const r=await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.equal(r.isError,undefined);assert.equal(f.state.state.focus.id,7);
 assert.match(f.getTodos()[0].description,/Existing owner description/);
 assert.equal(f.state.state.taskOrigin.system,'sentry');
 const snapshot=buildTaskProvenance(f.state.state);assert.ok(snapshot.taskRelations.some(r=>r.relation==='focus'&&r.label.includes('Finish notifications')));
});

test('completion refuses open linked work even when archived',async()=>{
 const f=fixture();await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 f.state.state.taskDescription=null;f.state.state.currentPhase='idle';
 const r=await handleFocusTool('complete_focus',{focusId:7,evidence:'Production preview and tests have been verified'},f.state,f.options);
 assert.equal(data(r).error,'FOCUS_OPEN_TASKS');assert.ok(!f.calls.some(c=>c.route.endsWith('/complete')));
});

test('completion requires linked work and completed local lifecycle before closing focus',async()=>{
 const f=fixture();let r=await handleFocusTool('complete_focus',{focusId:7,evidence:'All production checks passed'},f.state,f.options);
 assert.equal(r.isError,true);f.state.state.taskDescription=null;f.state.state.currentPhase='idle';
 r=await handleFocusTool('complete_focus',{focusId:7,evidence:'All production checks passed'},f.state,f.options);assert.equal(data(r).error,'FOCUS_NO_LINKED_TASKS');
});

test('verified completed linked tasks allow focus completion with recorded evidence',async()=>{
 const f=fixture();await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 f.getTodos()[0].is_completed=true;f.state.state.taskDescription=null;f.state.state.currentPhase='idle';
 const r=await handleFocusTool('complete_focus',{focusId:7,evidence:'Tests and deployed version were verified'},f.state,f.options);
 assert.equal(data(r).completed,true);assert.match(f.calls.find(c=>c.route.endsWith('/complete')).body.reason,/deployed version/);
});

test('failed local persistence is reported and does not retain an unverified focus attachment',async()=>{
 const f=fixture();f.state.save=async()=>({verified:false});
 const r=await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.equal(r.isError,true);assert.equal(f.state.state.focus,undefined);
});

test('canonical relink during remote reads prevents focus mutation',async()=>{
 const f=fixture();const original=f.client.request;
 f.client.request=async(method,route,body)=>{const result=await original(method,route,body);if(route==='/todos/20')f.state.state.zettly.todoId=21;return result;};
 const r=await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.equal(r.isError,true);assert.ok(!f.calls.some(c=>c.method==='PATCH'));
});

test('malformed and foreign focus rows never become active focus context',async()=>{
 const f=fixture();f.setFocuses([{id:7,user_id:2,title:'Foreign',completed_at:null}]);assert.equal((await handleFocusTool('get_current_focus',{},f.state,f.options)).isError,true);
 f.setFocuses([{id:7,user_id:1,title:'Incomplete response'}]);assert.equal((await handleFocusTool('get_current_focus',{},f.state,f.options)).isError,true);
});

test('required task focus is checked before workflow reset and forged metadata is removed',async()=>{
 const f=fixture();let r=await prepareTaskFocus({description:'Work',focusId:7,_verifiedFocus:{id:99}},f.options);
 assert.equal(r.args._verifiedFocus.id,7);
 r=await prepareTaskFocus({_verifiedFocus:{id:99}},f.options);assert.equal(r.args._verifiedFocus,undefined);
 f.setFocuses([]);r=await prepareTaskFocus({requireFocus:true},f.options);assert.equal(r.response.isError,true);
});

test('focus relation is suppressed after canonical Todo relinking',async()=>{
 const f=fixture();await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 f.state.state.zettly.todoId=21;
 assert.ok(!buildTaskProvenance(f.state.state).taskRelations.some(r=>r.relation==='focus'));
});

test('unknown provider exception bodies cannot leave focus tools',async()=>{
 const f=fixture();f.client.request=async()=>{throw Object.assign(Error('opaque private provider diagnostic'),{code:'ECONNRESET'});};
 const r=await handleFocusTool('get_current_focus',{},f.state,f.options);
 assert.equal(r.isError,true);assert.ok(!JSON.stringify(r).includes('opaque private'));
});

test('remote update responses cannot substitute for focus-link readback',async()=>{
 const f=fixture(),original=f.client.request;
 f.client.request=async(method,route,body)=>method==='PATCH'?{data:{id:20}}:original(method,route,body);
 const r=await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.equal(data(r).error,'FOCUS_LINK_UNVERIFIED');assert.equal(f.state.state.focus,undefined);
});

test('task identity changes during local save do not leave stale focus metadata',async()=>{
 const f=fixture();f.state.save=async()=>{f.state.state.workflowTaskId='new-task';return {verified:true};};
 assert.equal((await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options)).isError,true);
 assert.equal(f.state.state.focus,undefined);
});
