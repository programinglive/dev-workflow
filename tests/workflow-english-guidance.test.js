import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleToolCall} from '../tools/handlers.js';
import {withWorkflowState,testUtils,createRequest,createGitMock} from './test-helpers.js';

test('workflow initialization instructions require English implementation artifacts',async()=>{
 const {WORKFLOW_INSTRUCTIONS}=await import('../workflow-guidance.js');
 assert.match(WORKFLOW_INSTRUCTIONS.slice(0,512),/English/);
 for(const term of ['identifiers','comments','docstrings','test descriptions','developer documentation','commit messages']) assert.ok(WORKFLOW_INSTRUCTIONS.includes(term));
 assert.match(WORKFLOW_INSTRUCTIONS,/Zettly/);
 assert.match(WORKFLOW_INSTRUCTIONS,/Sentry/);
 assert.doesNotMatch(WORKFLOW_INSTRUCTIONS,/Factory/,'Factory sudah dipensiunkan dan tidak boleh disebut lagi');
 assert.match(WORKFLOW_INSTRUCTIONS,/verified fix/);
});

test('start and status responses remind the AI about English code and localized product text',async()=>{
 await withWorkflowState(async workflowState=>{
  const context={normalizeRequestArgs:args=>({args,error:null}),workflowState,exec:async()=>({stdout:''}),git:createGitMock(),utils:testUtils};
  const start=await handleToolCall({...context,request:createRequest('start_task',{description:'Enforce English implementation conventions',type:'bugfix',definitionOfDone:['Policy is delivered'],plan:['Verify policy delivery']})});
  assert.match(start.content[0].text,/English implementation/);
  assert.match(start.content[0].text,/localized/);
  const status=await handleToolCall({...context,request:createRequest('get_workflow_status',{})});
  assert.match(status.content[0].text,/English implementation/);
 });
});
