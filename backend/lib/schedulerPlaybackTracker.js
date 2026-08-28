class SchedulerPlaybackTracker {
  constructor({ onComplete, minTimeoutMs = 30 * 1000, maxTimeoutMs = 30 * 60 * 1000 }) {
    this.pending = new Map();
    this.onComplete = onComplete;
    this.minTimeoutMs = minTimeoutMs;
    this.maxTimeoutMs = maxTimeoutMs;
  }

  track(requestId, result, request, masterSocketIds) {
    if (!request.schedulerRunId || !request.fromClientSocketId || !masterSocketIds.size) return false;
    const durationSeconds = Number(result.duration);
    const timeoutMs = Math.min(
      this.maxTimeoutMs,
      Math.max(this.minTimeoutMs, (Number.isFinite(durationSeconds) ? durationSeconds * 1000 : 0) + this.minTimeoutMs)
    );
    const pending = {
      fromClientSocketId: request.fromClientSocketId,
      remainingMasterSocketIds: new Set(masterSocketIds),
      ...request,
      timeout: setTimeout(() => this.complete(requestId, 'timeout'), timeoutMs)
    };
    this.pending.set(requestId, pending);
    return true;
  }

  complete(requestId, status = 'ended', masterSocketId = null) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    this.onComplete(requestId, pending, status, masterSocketId);
    return true;
  }

  recordStatus(requestId, status, masterSocketId) {
    const pending = this.pending.get(requestId);
    if (!pending || !pending.remainingMasterSocketIds.has(masterSocketId)) return false;
    if (status !== 'ended') return this.complete(requestId, status, masterSocketId);
    pending.remainingMasterSocketIds.delete(masterSocketId);
    if (pending.remainingMasterSocketIds.size === 0) return this.complete(requestId, 'ended', masterSocketId);
    return true;
  }

  masterDisconnected(masterSocketId) {
    const stranded = [];
    this.pending.forEach((pending, requestId) => {
      if (!pending.remainingMasterSocketIds.delete(masterSocketId)) return;
      if (pending.remainingMasterSocketIds.size === 0) stranded.push(requestId);
    });
    stranded.forEach(requestId => this.complete(requestId, 'master-disconnected', masterSocketId));
  }

  cancelBySource(socketId) {
    const affected = [];
    this.pending.forEach((pending, requestId) => {
      if (pending.fromClientSocketId === socketId) affected.push(requestId);
    });
    affected.forEach(requestId => this.complete(requestId, 'source-disconnected', null));
  }
}

module.exports = SchedulerPlaybackTracker;
