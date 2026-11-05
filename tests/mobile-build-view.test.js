import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildLocation, visibleBuilds} from '../mobile-app/build-view.js';

test('build location distinguishes an explicit executor from a reporting machine', () => {
  assert.equal(buildLocation({buildHost: 'builder-vm'}, 'HELLOWORLD'), 'Build di builder-vm');
  assert.equal(buildLocation({}, 'HELLOWORLD'), 'Host build belum dilaporkan · Pelapor HELLOWORLD');
});

test('mobile build list deduplicates sessions and puts active work first', () => {
  const done = {session_key:'done', active_build:{target:'App', status:'succeeded', updatedAt:'2026-11-05T01:00:00Z'}};
  const live = {session_key:'live', active_build:{target:'API', status:'building', updatedAt:'2026-11-05T00:00:00Z'}};
  assert.deepEqual(visibleBuilds([done, live], [done]).map((item)=>item.session_key), ['live','done']);
});
