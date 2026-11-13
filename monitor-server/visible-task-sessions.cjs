'use strict';
function visibleTaskSessions(sessions) {
  if(!Array.isArray(sessions)) return [];
  return sessions.filter(session=>session&&session.state!=='ended'&&
    !['closed','done','cancelled','handed-off'].includes(session.phase)&&
    String(session.task||'').trim()!==''&&
    String(session.project_name||'').trim()!=='');
}
module.exports={visibleTaskSessions};
