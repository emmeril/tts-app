const test = require('node:test');
const assert = require('node:assert/strict');
const SchedulerPlaybackTracker = require('../lib/schedulerPlaybackTracker');

const createTracker = () => {
  const completions = [];
  const tracker = new SchedulerPlaybackTracker({
    minTimeoutMs: 1000,
    maxTimeoutMs: 1000,
    onComplete: (requestId, pending, status, masterSocketId) => {
      completions.push({ requestId, pending, status, masterSocketId });
    }
  });
  return { tracker, completions };
};

const schedulerRequest = {
  schedulerRunId: 'run-1',
  schedulerItem: '1.1',
  fromClientSocketId: 'source-1'
};

test('advances after the first master finishes the scheduler item', () => {
  const { tracker, completions } = createTracker();
  tracker.track('request-1', { duration: 1 }, schedulerRequest, new Set(['master-1', 'master-2']));

  assert.equal(tracker.recordStatus('request-1', 'ended', 'master-1'), true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, 'ended');

  assert.equal(tracker.recordStatus('request-1', 'ended', 'master-2'), false);
});

test('does not add a newly connected master to an active scheduler item', () => {
  const { tracker, completions } = createTracker();
  tracker.track('request-1', { duration: 1 }, schedulerRequest, new Set(['master-1']));

  assert.equal(tracker.recordStatus('request-1', 'ended', 'master-new'), false);
  assert.equal(completions.length, 0);

  tracker.recordStatus('request-1', 'ended', 'master-1');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, 'ended');
});

test('keeps playback active when one master disconnects and another remains', () => {
  const { tracker, completions } = createTracker();
  tracker.track('request-1', { duration: 1 }, schedulerRequest, new Set(['master-1', 'master-2']));

  tracker.masterDisconnected('master-1');
  assert.equal(completions.length, 0);

  tracker.recordStatus('request-1', 'ended', 'master-2');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, 'ended');
});

test('reports master-disconnected only after the last playback master leaves', () => {
  const { tracker, completions } = createTracker();
  tracker.track('request-1', { duration: 1 }, schedulerRequest, new Set(['master-1']));

  tracker.masterDisconnected('master-1');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, 'master-disconnected');
  assert.equal(completions[0].masterSocketId, 'master-1');
});
