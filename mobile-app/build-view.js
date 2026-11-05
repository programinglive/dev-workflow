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
  return reporter ? `Host build belum dilaporkan · Pelapor ${reporter}` : 'Host build belum dilaporkan';
}

export function isRunningBuild(status) {
  return ['building', 'testing', 'scanning', 'deploying'].includes(String(status || '').toLowerCase());
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
