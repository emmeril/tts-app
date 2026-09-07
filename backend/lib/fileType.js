const fileType = require('file-type');

// file-type renamed this API after v16. Support both shapes so a stale or
// partially upgraded node_modules directory cannot break every audio upload.
const detectFileType = fileType.fileTypeFromBuffer || fileType.fromBuffer;

if (typeof detectFileType !== 'function') {
  throw new Error('Versi package file-type tidak kompatibel');
}

module.exports = { detectFileType };
