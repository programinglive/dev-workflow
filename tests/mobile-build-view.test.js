import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildLocation, parseEventDetail, visibleBuilds} from '../mobile-app/build-view.js';

test('build location distinguishes an explicit executor from a reporting machine', () => {
  assert.equal(buildLocation({buildHost: 'builder-vm'}, 'HELLOWORLD'), 'Build di builder-vm');
  assert.equal(buildLocation({}, 'HELLOWORLD'), 'Host build belum dilaporkan · Pelapor HELLOWORLD');
});

test('mobile build list deduplicates sessions and puts active work first', () => {
  const done = {session_key:'done', active_build:{target:'App', status:'succeeded', updatedAt:'2026-11-05T01:00:00Z'}};
  const live = {session_key:'live', active_build:{target:'API', status:'building', updatedAt:'2026-11-05T00:00:00Z'}};
  assert.deepEqual(visibleBuilds([done, live], [done]).map((item)=>item.session_key), ['live','done']);
});

test('mobile parseEventDetail extracts JSON build structures and leaves text intact', () => {
  const jsonBuild = JSON.stringify({
    status: 'succeeded',
    target: 'Personal Voice Input Android APK',
    buildHost: 'HELLOWORLD',
    command: 'npm run tauri -- android build --apk',
    stage: 'Compiling Tauri Android and whisper-rs',
    progress: 100,
    output: 'Release binary compiled successfully in 5m 50s',
  });
  const parsed = parseEventDetail(jsonBuild);
  assert.equal(parsed.isBuild, true);
  assert.equal(parsed.data.target, 'Personal Voice Input Android APK');
  assert.equal(parsed.data.status, 'succeeded');
  assert.equal(parsed.text, 'Release binary compiled successfully in 5m 50s');

  const plain = parseEventDetail('some generic text');
  assert.equal(plain.isBuild, false);
  assert.equal(plain.text, 'some generic text');
});
