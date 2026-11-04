'use strict';
function visibleTaskSessions(sessions) {
  if(!Array.isArray(sessions)) return [];
  return sessions.filter(session=>session&&session.state!=='ended'&&
    !['closed','done','cancelled'].includes(session.phase)&&
    (String(session.task||'').trim()||String(session.session_title||'').trim()));
}
module.exports={visibleTaskSessions};
