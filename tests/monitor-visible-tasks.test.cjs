const {test}=require('node:test');
const assert=require('node:assert/strict');
const {visibleTaskSessions}=require('../monitor-server/visible-task-sessions.cjs');
test('active task cards and count exclude anonymous connections and ended sessions',()=>{
 const sessions=[{task:'',session_title:'',phase:'idle'}, {task:'  ',session_title:' ',phase:'idle'},
  {task:'Old work',state:'ended',phase:'coding'}, {task:'Closed',phase:'closed'},
  {task:'Deploy MCP on three devices',phase:'coding',state:'live'},
  {task:'',session_title:'Repair printer',phase:'idle',state:'idle'}];
 const visible=visibleTaskSessions(sessions);
 assert.deepEqual(visible,[sessions[4],sessions[5]]);
 assert.equal(visibleTaskSessions(null).length,0);
 assert.equal(visibleTaskSessions(sessions).length,2);
});
