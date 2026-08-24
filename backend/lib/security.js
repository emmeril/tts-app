const crypto = require('crypto');

const safeTokenEquals = (provided, expected) => {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
};

const getRequestToken = (req) => {
  const authorization = req.get('authorization') || '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  return req.get('x-socket-token') || req.get('x-admin-token') || '';
};

const hasAudioSignature = (buffer, contentType) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;

  if (contentType === 'audio/mpeg' || contentType === 'audio/mp3') {
    return buffer.subarray(0, 3).toString('ascii') === 'ID3'
      || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  }
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
  }
  if (contentType === 'audio/ogg') return buffer.subarray(0, 4).toString('ascii') === 'OggS';
  if (contentType === 'audio/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (contentType === 'audio/mp4') return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  if (contentType === 'audio/aac') return buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0;
  if (contentType === 'audio/flac' || contentType === 'audio/x-flac') return buffer.subarray(0, 4).toString('ascii') === 'fLaC';
  return false;
};

module.exports = { safeTokenEquals, getRequestToken, hasAudioSignature };
