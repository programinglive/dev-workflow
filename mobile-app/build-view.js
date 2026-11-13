const LABELS = {
  building: 'MEMBANGUN',
  testing: 'MENGUJI',
  scanning: 'MEMINDAI',
  deploying: 'DEPLOY',
  succeeded: 'BERHASIL',
  failed: 'GAGAL',
  idle: 'IDLE',
};

export function buildStatusLabel(status) {
  return LABELS[String(status || '').toLowerCase()] || 'BUILD';
}

export function buildLocation(build, reporter) {
  const host = typeof build?.buildHost === 'string' ? build.buildHost.trim() : '';
  if (host) return `Build di ${host}`;
  // A build host is only claimed when the executor reported one. Without it,
  // name the machine that sent the report: it answers "where did this come
  // from" without inventing a builder.
  if (reporter) return `Dilaporkan dari ${reporter}`;
  return 'Host build tidak dilaporkan';
}

export function isRunningBuild(status) {
  return ['building', 'testing', 'scanning', 'deploying'].includes(String(status || '').toLowerCase());
}

export function parseEventDetail(detail) {
  if (detail === null || detail === undefined) return { isBuild: false, data: null, text: '' };
  if (typeof detail === 'object') {
    const isBuild = Boolean(
      detail.target || detail.command || detail.stage || detail.buildHost || detail.status || detail.progress !== undefined || detail.output
    );
    return {
      isBuild,
      data: isBuild ? detail : null,
      text: detail.output || detail.stage || detail.target || JSON.stringify(detail),
    };
  }
  const str = String(detail).trim();
  if (str.startsWith('{') && str.endsWith('}')) {
    try {
      const obj = JSON.parse(str);
      if (obj && typeof obj === 'object') {
        const isBuild = Boolean(
          obj.target || obj.command || obj.stage || obj.buildHost || obj.status || obj.progress !== undefined || obj.output
        );
        return {
          isBuild,
          data: isBuild ? obj : null,
          text: obj.output || obj.stage || obj.target || str,
        };
      }
    } catch {
      // not JSON
    }
  }
  return { isBuild: false, data: null, text: str };
}

export function visibleBuilds(sessions = [], history = []) {
  const seen = new Set();
  return [...sessions, ...history]
    .filter((item) => {
      if (!item?.session_key || !item.active_build?.target || seen.has(item.session_key)) return false;
      seen.add(item.session_key);
      return true;
    })
    .sort((a, b) => Number(isRunningBuild(b.active_build.status)) - Number(isRunningBuild(a.active_build.status)) ||
      Date.parse(b.active_build.updatedAt || b.updated_at || 0) - Date.parse(a.active_build.updatedAt || a.updated_at || 0))
    .slice(0, 20);
}
