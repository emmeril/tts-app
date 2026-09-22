const getMasterAudioTargets = (masterSocketIds, sourceSocketId, schedulerRequest = false) => {
  const activeMasterSocketIds = new Set(masterSocketIds);
  if (!schedulerRequest) return activeMasterSocketIds;
  return activeMasterSocketIds.has(sourceSocketId)
    ? new Set([sourceSocketId])
    : new Set();
};

module.exports = getMasterAudioTargets;
