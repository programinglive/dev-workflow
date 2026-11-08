import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assignWorkflowIdentity,validateZettlyTaskArguments} from '../zettly-workflow.js';
import {buildTaskProvenance,originForTask} from '../task-provenance.js';
import {buildSnapshot} from '../monitor.js';
const factoryId='11111111-1111-4111-8111-111111111111';
test('auto-created tracking Todos never replace the true original source',()=>{
 const state={taskDescription:'Fix issue',projectDir:'/repo'};
 assignWorkflowIdentity(state,null,{source:{system:'sentry',id:'123'}});
 state.zettly.todoId=170;state.zettly.externalLinks={sentry:{issueId:'123',shortId:'APP-1',url:'https://example.sentry.io/issues/123/'},factory:{id:factoryId,taskKey:'TASK-1'}};
 const result=buildTaskProvenance(state);
 assert.equal(result.taskOrigin.system,'sentry');assert.equal(result.taskOrigin.id,'123');
 assert.deepEqual(result.taskRelations.map(link=>link.system).sort(),['factory','sentry','zettly']);
 assert.ok(result.taskRelations.every(link=>link.id&&link.url));
 const snapshot=buildSnapshot({state,sessionKey:'test',env:{}});
 assert.deepEqual(snapshot.taskOrigin,result.taskOrigin);assert.equal(snapshot.taskRelations.length,3);assert.equal(snapshot.workflowTaskId,state.workflowTaskId);
});
test('explicit Zettly selection identifies origin while a direct request remains manual',()=>{
 const state={taskDescription:'Continue the task',projectDir:'/repo'};
 assignWorkflowIdentity(state,null,{zettlyTodoId:170});assert.equal(state.taskOrigin.system,'zettly');assert.equal(state.taskOrigin.id,'170');
 const previous=structuredClone(state);assignWorkflowIdentity(state,previous,{});assert.deepEqual(state.taskOrigin,previous.taskOrigin);
 const direct={taskDescription:'A new request',projectDir:'/repo'};assignWorkflowIdentity(direct,null,{});direct.zettly.todoId=171;
 assert.equal(buildTaskProvenance(direct).taskOrigin.system,'manual');
 assert.equal(buildTaskProvenance({zettly:{todoId:171}}).taskOrigin.system,'unknown');
});
test('Factory origin and Zettelkasten context links preserve identities and discard unsafe URLs',()=>{
 const origin=originForTask({source:{system:'factory',id:factoryId}});
 assert.equal(origin.system,'factory');
 const result=buildTaskProvenance({taskOrigin:origin,zettly:{todoId:170,externalLinks:{factory:{id:factoryId},sentry:{issueId:'123',url:'javascript:alert(1)'}}},zettlyContext:{todoId:170,nodes:[{id:170,distance:0},{id:171,distance:1,title:'Prior decision'}],edges:[{source:170,target:171,relation:'related_todos'}]}});
 assert.ok(result.taskRelations.some(link=>link.system==='zettly'&&link.id==='171'&&link.relation==='related_to'));
 assert.ok(!JSON.stringify(result).includes('javascript:'));
});
test('invalid or conflicting source IDs fail validation before workflow reset',()=>{
 for(const source of [{system:'other',id:'123'},{system:'zettly',id:'0'},{system:'sentry',id:'../123'},{system:'factory',id:'not-a-uuid'}])assert.match(validateZettlyTaskArguments({source}),/source/i);
 assert.match(validateZettlyTaskArguments({source:{system:'zettly',id:'170'},zettlyTodoId:171}),/source/i);
 assert.equal(validateZettlyTaskArguments({source:{system:'zettly',id:'170'},zettlyTodoId:170}),null);
});
test('cached context from another canonical Todo is never reported as a task relation',()=>{
 const result=buildTaskProvenance({zettly:{todoId:170},zettlyContext:{todoId:166,nodes:[{id:167,distance:1,title:'Other task context'}],edges:[]}});
 assert.ok(!result.taskRelations.some(link=>link.id==='167'));
});
test('Zettly Draw remains a distinct visual-plan relation with a safe URL',()=>{
 const state={taskOrigin:{system:'manual',id:''},zettly:{todoId:215,externalLinks:{factory:{id:factoryId},drawing:{id:5,url:'https://zettly.programinglive.com/draw/5'}}}};
 const relation=buildTaskProvenance(state).taskRelations.find(item=>item.system==='zettly_draw');
 assert.equal(relation.id,'5');assert.equal(relation.relation,'visual_plan');assert.equal(relation.url,'https://zettly.programinglive.com/draw/5');
});
