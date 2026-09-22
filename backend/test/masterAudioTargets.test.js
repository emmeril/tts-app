const test = require('node:test');
const assert = require('node:assert/strict');
const getMasterAudioTargets = require('../lib/masterAudioTargets');

test('normal audio targets every active master', () => {
  const targets = getMasterAudioTargets(new Set(['master-1', 'master-2']), 'client-1', false);
  assert.deepEqual([...targets], ['master-1', 'master-2']);
});

test('scheduler audio targets only its master owner', () => {
  const targets = getMasterAudioTargets(new Set(['master-1', 'master-2']), 'master-2', true);
  assert.deepEqual([...targets], ['master-2']);
});

test('scheduler audio has no target when its owner is not an active master', () => {
  const targets = getMasterAudioTargets(new Set(['master-1', 'master-2']), 'client-1', true);
  assert.deepEqual([...targets], []);
});
