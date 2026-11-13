const {test}=require('node:test');
const assert=require('node:assert/strict');
const {visibleTaskSessions}=require('../monitor-server/visible-task-sessions.cjs');
test('active task cards and count exclude anonymous connections, sessions without task, sessions without project, and ended sessions',()=>{
 const sessions=[
  {task:'',session_title:'',project_name:'clinic',phase:'idle'},
  {task:'  ',session_title:' ',project_name:'clinic',phase:'idle'},
  {task:'Old work',project_name:'clinic',state:'ended',phase:'coding'},
  {task:'Closed',project_name:'clinic',phase:'closed'},
  {task:'Deploy MCP on three devices',project_name:'dev-workflow-mcp-server',phase:'coding',state:'live'},
  {task:'',session_title:'Repair printer',project_name:'printer-erp',phase:'idle',state:'idle'},
  {task:'Orphan task without project',project_name:'',phase:'coding',state:'live'},
 ];
 const visible=visibleTaskSessions(sessions);
 assert.deepEqual(visible,[sessions[4]]);
 assert.equal(visibleTaskSessions(null).length,0);
 assert.equal(visibleTaskSessions(sessions).length,1);
});
