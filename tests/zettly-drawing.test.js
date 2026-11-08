import {test} from 'node:test';
import assert from 'node:assert/strict';
import {drawingPayload,flowGraph,flowNodes,syncZettlyDrawing} from '../zettly-drawing.js';

const code='flowchart TD\nA[Verify source] --> B[Link Factory]\nB --> C[Implement fix]\nC --> D[Verify release]';
const factoryId='c8d61cc0-d855-4078-b89c-81bb330b169c';
const state=()=>({workflowTaskId:'workflow-1',taskDescription:'Repair monitor',mermaidCode:code,featureFlowDescription:'A verified plan',zettly:{todoId:215,externalLinks:{factory:{id:factoryId}}}});

test('Mermaid nodes become editable Draw shapes and a safe thumbnail',()=>{
 assert.deepEqual(flowNodes(code),['Verify source','Link Factory','Implement fix','Verify release']);
 const result=drawingPayload(state(),code,'A verified plan');
 const store=result.document.document.store;
 assert.equal(Object.values(store).filter(record=>record.type==='geo').length,4);
 assert.equal(Object.values(store).filter(record=>record.type==='arrow').length,3);
 assert.equal(store['document:document'].meta.factoryTaskId,factoryId);
 assert.match(result.thumbnail,/^data:image\/svg\+xml/);
 assert.ok(!decodeURIComponent(result.thumbnail).includes('<script>'));
});

test('decision branches and retries remain separate arrows in the Draw document',()=>{
 const graph='flowchart TD\nA[Inspect] --> B{Fixed already?}\nB -- No --> C[Repair]\nC --> B\nB -- Yes --> D[Verify]';
 const parsed=flowGraph(graph);
 assert.deepEqual(parsed.edges.map(edge=>[edge.from,edge.to,edge.label]),[['A','B',''],['B','C','No'],['C','B',''],['B','D','Yes']]);
 const store=drawingPayload(state(),graph,'Decision flow').document.document.store;
 const arrows=Object.values(store).filter(record=>record.type==='arrow');
 assert.equal(arrows.length,4);assert.ok(arrows.some(record=>record.meta.from==='C'&&record.meta.to==='B'));
 assert.ok(arrows.some(record=>record.props.richText?.content?.[0]?.content?.[0]?.text==='Yes'));
});
test('standard Mermaid pipe labels remain attached to their branches',()=>{
 const parsed=flowGraph('flowchart TD; A[Start] --> B{Ready?}; B -->|Yes| C[Ship]; B -->|No| D[Fix]');
 assert.deepEqual(parsed.edges.map(edge=>[edge.from,edge.to,edge.label]),[['A','B',''],['B','C','Yes'],['B','D','No']]);
});

test('plain text and disconnected placeholders cannot satisfy the Mermaid gate',()=>{
 for(const invalid of ['hello','flowchart TD; A[Only one node]','graph TD; A'])assert.throws(()=>flowGraph(invalid),/Mermaid|connected/);
});

test('Draw creation is linked to the same Todo and repeated calls reuse it',async()=>{
 const current=state();let calls=0;let saves=0;
 const workflowState={state:current,async save(){saves++;return {verified:true};}};
 const client={async request(method,route,body){calls++;assert.equal(method,'POST');assert.equal(route,'/drawings');assert.match(body.title,/#215/);return {drawing:{id:5}};}};
 const first=await syncZettlyDrawing(workflowState,{client});
 const second=await syncZettlyDrawing(workflowState,{client});
 assert.equal(first.id,5);assert.equal(second.reused,true);assert.equal(calls,1);assert.ok(saves>=2);
 assert.equal(current.zettly.externalLinks.drawing.url,'https://zettly.programinglive.com/draw/5');
});

test('an uncertain create result does not silently create another drawing',async()=>{
 const current=state();const workflowState={state:current,async save(){return {verified:true};}};let calls=0;
 const client={async request(){calls++;throw Error('Connection closed after write');}};
 const first=await syncZettlyDrawing(workflowState,{client});const second=await syncZettlyDrawing(workflowState,{client});
 assert.equal(first.ok,false);assert.match(second.note,/uncertain/);assert.equal(calls,1);
});

test('tldraw document complies with tldraw v4 store schema, session, and fractional indexing',()=>{
 const largeFlow='flowchart TD\n  A[Step 1] --> B[Step 2]\n  B --> C[Step 3]\n  C --> D[Step 4]\n  D --> E[Step 5]\n  E --> F[Step 6]\n  F --> G[Step 7]\n  G --> H[Step 8]\n  H --> I[Step 9]\n  I --> J[Step 10]';
 const result=drawingPayload(state(),largeFlow,'Large flow');
 const doc=result.document;
 assert.ok(doc.document.schema);
 assert.equal(doc.session.currentPageId,'page:page');
 const store=doc.document.store;
 assert.ok(store['page:page']);
 assert.equal(store['page:page'].id,'page:page');
 
 const shapes=Object.values(store).filter(r=>r.typeName==='shape');
 for(const shape of shapes){
   assert.equal(shape.parentId,'page:page');
   assert.match(shape.index,/^[a-z][0-9A-Za-z]+$/);
   assert.ok(!shape.index.includes('10')); // Fractional index must not be naive a10
   if(shape.type==='geo'){
     assert.equal(shape.props.url,'');
   }
   if(shape.type==='arrow'){
     assert.equal(shape.props.url,undefined);
   }
   const textNode=shape.props.richText?.content?.[0]?.content?.[0];
   if(textNode){
     assert.equal(typeof textNode.text,'string');
     assert.ok(textNode.text.length>0);
   }
 }
});
