require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const cors = require('cors');
const socketIo = require('socket.io');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const { fromBuffer: detectFileType } = require('file-type');
const { parseBuffer: parseAudioMetadata } = require('music-metadata');
const googleTTSService = require('./services/googleTTSService');
const { getRequestToken, hasAudioSignature, safeTokenEquals } = require('./lib/security');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const MAX_TTS_TEXT_LENGTH = 5000;
const MAX_QUEUE_LENGTH = parseInt(process.env.MAX_QUEUE_LENGTH, 10) || 100;
const MAX_UPLOAD_AUDIO_SIZE_MB = parseInt(process.env.MAX_UPLOAD_AUDIO_SIZE_MB, 10) || 20;
const MAX_UPLOAD_AUDIO_SIZE = MAX_UPLOAD_AUDIO_SIZE_MB * 1024 * 1024;
const MAX_UPLOAD_STORAGE_MB = parseInt(process.env.MAX_UPLOAD_STORAGE_MB, 10) || 500;
const MAX_UPLOAD_STORAGE_SIZE = MAX_UPLOAD_STORAGE_MB * 1024 * 1024;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SOCKET_AUTH_TOKEN = process.env.SOCKET_AUTH_TOKEN || '';
const CLIENT_SESSION_COOKIE = 'tts_session';
const CLIENT_SESSION_TTL_SECONDS = parseInt(process.env.CLIENT_SESSION_TTL_SECONDS, 10) || 86400;
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === 'true'
  || (process.env.SESSION_COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
const clientSessions = new Map();
const defaultAllowedOrigins = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  process.env.SERVER_IP ? `http://${process.env.SERVER_IP}:${PORT}` : null
].filter(Boolean);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || defaultAllowedOrigins.join(','))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const supportedAudioTypes = new Map([
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/ogg', '.ogg'],
  ['audio/webm', '.webm'],
  ['audio/mp4', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/flac', '.flac'],
  ['audio/x-flac', '.flac']
]);

const supportedAudioExtensions = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.webm', 'audio/webm'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac']
]);

const audioSignatureTypes = [
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/flac'
];

const uploadRateLimiter = new RateLimiterMemory({
  keyPrefix: 'audio-upload',
  points: parseInt(process.env.UPLOAD_RATE_LIMIT, 10) || 30,
  duration: parseInt(process.env.UPLOAD_RATE_WINDOW, 10) || 60
});

const limitAudioUploads = async (req, res, next) => {
  try {
    await uploadRateLimiter.consume(req.ip || req.socket.remoteAddress || 'unknown');
    next();
  } catch (rateLimit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((rateLimit.msBeforeNext || 1000) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    sendApiError(res, 429, 'Terlalu banyak upload audio. Coba lagi beberapa saat.', {
      retryAfterSeconds
    });
  }
};

const parseCookies = (cookieHeader = '') => cookieHeader.split(';').reduce((cookies, pair) => {
  const separator = pair.indexOf('=');
  if (separator === -1) return cookies;

  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (name) cookies[name] = value;
  return cookies;
}, {});

const getClientSession = (sessionId) => {
  if (!sessionId) return null;

  const session = clientSessions.get(sessionId);
  if (!session) return null;

  if (Date.now() - session.lastSeenAt > CLIENT_SESSION_TTL_SECONDS * 1000) {
    clientSessions.delete(sessionId);
    return null;
  }

  session.lastSeenAt = Date.now();
  return session;
};

const getClientSessionFromCookieHeader = (cookieHeader) => {
  const sessionId = parseCookies(cookieHeader || '')[CLIENT_SESSION_COOKIE];
  return getClientSession(sessionId);
};

const createClientSession = () => {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const session = { id: sessionId, createdAt: Date.now(), lastSeenAt: Date.now() };
  clientSessions.set(sessionId, session);
  return session;
};

const setClientSessionCookie = (res, sessionId) => {
  const attributes = [
    `${CLIENT_SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    `Max-Age=${CLIENT_SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (SESSION_COOKIE_SECURE) attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
};

const ensureClientSession = (req, res, next) => {
  const existingSession = getClientSessionFromCookieHeader(req.get('cookie'));
  if (existingSession) {
    req.clientSession = existingSession;
    return next();
  }

  // API clients must present a session (or the legacy shared token); create sessions for browsers only.
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return next();

  const session = createClientSession();
  req.clientSession = session;
  setClientSessionCookie(res, session.id);
  return next();
};

const requireClientSession = (req, res, next) => {
  if (req.clientSession) return next();

  // Keep the shared token as a temporary migration fallback for older clients.
  if (SOCKET_AUTH_TOKEN && safeTokenEquals(getRequestToken(req), SOCKET_AUTH_TOKEN)) return next();

  return sendApiError(res, 401, 'Session client tidak valid atau sudah kedaluwarsa');
};

const detectAudioSignatureType = (buffer) => (
  audioSignatureTypes.find((contentType) => hasAudioSignature(buffer, contentType)) || null
);

const inspectAudioUpload = async (buffer) => {
  const detectedFile = await detectFileType(buffer);
  const extension = detectedFile?.ext ? `.${detectedFile.ext.toLowerCase()}` : '';
  const contentType = supportedAudioExtensions.get(extension);

  if (!contentType || !hasAudioSignature(buffer, contentType)) {
    throw new Error('Isi file tidak dikenali sebagai format audio yang didukung');
  }

  const metadata = await parseAudioMetadata(buffer, detectedFile.mime, {
    duration: false,
    skipCovers: true
  });
  const channelCount = Number(metadata.format.numberOfChannels);
  const sampleRate = Number(metadata.format.sampleRate);

  if (!metadata.format.codec || !Number.isFinite(channelCount) || channelCount < 1
    || !Number.isFinite(sampleRate) || sampleRate < 1) {
    throw new Error('File tidak memiliki stream audio yang valid');
  }

  return {
    extension: contentType === 'audio/mp4' ? '.m4a' : extension,
    contentType
  };
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let uploadStorageSize = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .reduce((total, entry) => {
    try {
      return total + fs.statSync(path.join(UPLOAD_DIR, entry.name)).size;
    } catch (error) {
      return total;
    }
  }, 0);

const isAllowedOrigin = (origin) => {
  if (!origin) {
    return true;
  }

  return allowedOrigins.includes(origin);
};

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST']
};

const io = socketIo(server, {
  pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT, 10) || 5000,
  pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL, 10) || 25000,
  cors: corsOptions
});

// Middleware
app.use(morgan(process.env.LOG_LEVEL || 'dev'));
app.use(cors(corsOptions));
app.use(ensureClientSession);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

const sessionCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - CLIENT_SESSION_TTL_SECONDS * 1000;
  clientSessions.forEach((session, sessionId) => {
    if (session.lastSeenAt <= cutoff) clientSessions.delete(sessionId);
  });
}, 5 * 60 * 1000);
sessionCleanupTimer.unref?.();

// Store connected clients and their info
const connectedClients = new Map();
let masterClients = new Set(); // Multiple masters
let masterRequestQueue = [];
const pendingSchedulerPlaybacks = new Map();

// Track previous masters for reconnection
const previousMasters = new Map(); // clientId -> { wantsToBeMaster: true, lastSeen: Date }

// Generate unique client ID
const generateClientId = () => {
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
};

const generateRequestId = () => {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
};

const getSchedulerContext = (data = {}) => ({
  schedulerId: data.schedulerId || null,
  schedulerName: data.schedulerName || null,
  schedulerItem: data.schedulerItem || null,
  schedulerRunId: data.schedulerRunId || null
});

const logInfo = (message) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

const logError = (message, error) => {
  if (error !== undefined) {
    console.error(`[${new Date().toISOString()}] ${message}`, error);
    return;
  }

  console.error(`[${new Date().toISOString()}] ${message}`);
};

const sendApiError = (res, statusCode, error, extras = {}) => {
  return res.status(statusCode).json({
    success: false,
    error,
    timestamp: new Date().toISOString(),
    ...extras
  });
};

const emitSocketError = (socket, eventName, error, extras = {}) => {
  socket.emit(eventName, {
    success: false,
    error,
    timestamp: new Date().toISOString(),
    ...extras
  });
};

const getBearerToken = (req) => {
  const authHeader = req.get('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  return req.get('x-admin-token') || '';
};

const requireAdminToken = (req, res, next) => {
  if (!ADMIN_TOKEN) {
    return sendApiError(res, 503, 'ADMIN_TOKEN belum dikonfigurasi di server');
  }

  if (getBearerToken(req) !== ADMIN_TOKEN) {
    return sendApiError(res, 401, 'Token admin tidak valid atau tidak ada');
  }

  return next();
};

const isSocketAuthorized = (socket) => {
  if (getClientSessionFromCookieHeader(socket.handshake.headers.cookie)) return true;

  // Keep the shared token as a temporary migration fallback for older clients.
  return Boolean(SOCKET_AUTH_TOKEN) && (
    safeTokenEquals(socket.handshake.auth?.token, SOCKET_AUTH_TOKEN)
    || safeTokenEquals(socket.handshake.headers['x-socket-token'], SOCKET_AUTH_TOKEN)
  );
};

const normalizeSpeed = (speed) => {
  return Math.max(0.5, Math.min(parseFloat(speed) || 1.0, 2.0));
};

const toBoolean = (value) => {
  return value === true || value === 'true' || value === 1 || value === '1';
};

const findClientRecordById = (clientId) => {
  for (const [socketId, client] of connectedClients.entries()) {
    if (client.id === clientId) {
      return { socketId, client };
    }
  }

  return null;
};

const getConnectedClientsSnapshot = () => {
  return Array.from(connectedClients.values()).map((client) => ({
    id: client.id,
    isMaster: client.isMaster,
    joinedAt: client.joinedAt,
    lastActivity: client.lastActivity,
    clientInfo: client.clientInfo,
    wantsToBeMaster: client.wantsToBeMaster
  }));
};

const getMasterListSnapshot = () => {
  return Array.from(masterClients).map((sid) => ({
    id: connectedClients.get(sid)?.id,
    socketId: sid
  }));
};

const promotePreviousMasterRecord = (currentClientId, previousClientId) => {
  if (!previousClientId || previousClientId === currentClientId) {
    return;
  }

  const previousRecord = previousMasters.get(previousClientId);
  if (!previousRecord) {
    return;
  }

  previousMasters.set(currentClientId, {
    ...previousRecord,
    migratedFrom: previousClientId,
    lastSeen: new Date()
  });
  previousMasters.delete(previousClientId);
};

const completeSchedulerPlayback = (requestId, status = 'ended', masterSocketId = null) => {
  const pending = pendingSchedulerPlaybacks.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingSchedulerPlaybacks.delete(requestId);

  if (pending.fromClientSocketId && connectedClients.has(pending.fromClientSocketId)) {
    io.to(pending.fromClientSocketId).emit('scheduler-item-finished', {
      success: status === 'ended',
      status,
      requestId,
      masterSocketId,
      ...getSchedulerContext(pending)
    });
  }
  return true;
};

const trackSchedulerPlayback = (requestId, result, request) => {
  if (!request.schedulerRunId || !request.fromClientSocketId) return;

  const durationSeconds = Number(result.duration);
  const timeoutMs = Math.min(
    30 * 60 * 1000,
    Math.max(30 * 1000, (Number.isFinite(durationSeconds) ? durationSeconds * 1000 : 0) + 30 * 1000)
  );
  const pending = {
    fromClientSocketId: request.fromClientSocketId,
    masterSocketIds: new Set(masterClients),
    ...getSchedulerContext(request),
    timeout: null
  };
  pending.timeout = setTimeout(() => completeSchedulerPlayback(requestId, 'timeout'), timeoutMs);
  pendingSchedulerPlaybacks.set(requestId, pending);
};

const emitTtsAudioToMasters = (result, request) => {
  const requestId = generateRequestId();
  trackSchedulerPlayback(requestId, result, request);

  masterClients.forEach((masterSocketId) => {
    io.to(masterSocketId).emit('tts-audio', {
      ...result,
      fromClientId: request.fromClientId,
      fromClientSocketId: request.fromClientSocketId || null,
      timestamp: new Date().toISOString(),
      priority: request.priority || 'normal',
      requestId,
      ...getSchedulerContext(request),
      forMasterOnly: true,
      masterCount: masterClients.size
    });
  });

  return requestId;
};

const getUploadedAudio = (audioUrl) => {
  if (typeof audioUrl !== 'string' || audioUrl.length > 300) {
    return null;
  }

  let pathname;
  try {
    pathname = new URL(audioUrl, 'http://local').pathname;
  } catch (error) {
    return null;
  }

  const match = pathname.match(/^\/api\/audio\/files\/(audio_[a-z0-9_-]+\.(?:mp3|wav|ogg|webm|m4a|aac|flac))$/i);
  if (!match) {
    return null;
  }

  const filename = match[1];
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }

  // Existing uploads may have a wrong extension, so validate their bytes and serve the real type.
  let fileDescriptor;
  let contentType;
  try {
    const header = Buffer.alloc(32);
    fileDescriptor = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, 0);
    contentType = detectAudioSignatureType(header.subarray(0, bytesRead));
    if (!contentType) return null;
  } catch (error) {
    return null;
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }

  return {
    filename,
    filePath,
    audioUrl: `/api/audio/files/${filename}`,
    contentType,
    size: fs.statSync(filePath).size
  };
};

const emitUploadedAudioToMasters = (request) => {
  const uploadedAudio = getUploadedAudio(request.audioUrl);
  if (!uploadedAudio) {
    throw new Error('File audio upload tidak ditemukan');
  }

  emitTtsAudioToMasters({
    success: true,
    audioUrl: uploadedAudio.audioUrl,
    duration: request.duration !== null && request.duration !== undefined && Number.isFinite(Number(request.duration))
      ? Number(request.duration)
      : null,
    format: uploadedAudio.contentType,
    sourceType: request.sourceType === 'voice-note' ? 'voice-note' : 'upload',
    fileName: String(request.fileName || (request.sourceType === 'voice-note' ? 'Voice note' : 'Audio upload')).slice(0, 160),
    audioSize: uploadedAudio.size
  }, request);
};

const processQueuedMasterRequests = async () => {
  if (masterClients.size === 0 || masterRequestQueue.length === 0) {
    return;
  }

  const queuedRequests = masterRequestQueue.splice(0, masterRequestQueue.length);
  logInfo(`Processing queued master requests: count=${queuedRequests.length}, masters=${masterClients.size}`);

  for (const request of queuedRequests) {
    try {
      if (request.kind === 'audio') {
        emitUploadedAudioToMasters(request);

        if (request.fromClientSocketId && connectedClients.has(request.fromClientSocketId)) {
          io.to(request.fromClientSocketId).emit('audio-complete', {
            success: true,
            message: `${request.sourceType === 'voice-note' ? 'Voice note' : 'Audio upload'} antrian telah dikirim ke ${masterClients.size} Master Controller`,
            masterCount: masterClients.size,
            sourceType: request.sourceType === 'voice-note' ? 'voice-note' : 'upload',
            queued: true,
            schedulerId: request.schedulerId || null,
            schedulerName: request.schedulerName || null,
            schedulerItem: request.schedulerItem || null,
            schedulerRunId: request.schedulerRunId || null
          });
        }
        continue;
      }

      const result = await googleTTSService.convertTextToSpeech({
        text: request.text,
        language: request.language || 'id-ID',
        speed: normalizeSpeed(request.speed)
      });

      emitTtsAudioToMasters(result, request);

      if (request.fromClientSocketId && connectedClients.has(request.fromClientSocketId)) {
        io.to(request.fromClientSocketId).emit('tts-complete', {
          success: true,
          message: `Audio antrian telah dikirim ke ${masterClients.size} Master Controller`,
          masterCount: masterClients.size,
          textLength: request.text.length,
          language: request.language || 'id-ID',
          duration: result.duration,
          queued: true,
          schedulerId: request.schedulerId || null,
          schedulerName: request.schedulerName || null,
          schedulerItem: request.schedulerItem || null,
          schedulerRunId: request.schedulerRunId || null
        });
      }
    } catch (error) {
      logError(`Failed to process queued master request from ${request.fromClientId}`, error.message);

      if (request.fromClientSocketId && connectedClients.has(request.fromClientSocketId)) {
        const isUploadedAudio = request.kind === 'audio';
        const errorEvent = isUploadedAudio ? 'audio-error' : 'tts-error';
        const requestLabel = isUploadedAudio
          ? (request.sourceType === 'voice-note' ? 'voice note' : 'audio upload')
          : 'TTS';
        emitSocketError(io.to(request.fromClientSocketId), errorEvent, `Gagal memproses antrian ${requestLabel} (Detail: ${error.message})`, {
          queued: true,
          ...getSchedulerContext(request)
        });
      }
    }
  }
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  if (!isSocketAuthorized(socket)) {
    emitSocketError(socket, 'auth-error', 'Token socket tidak valid atau tidak ada');
    socket.disconnect(true);
    return;
  }

  const clientId = generateClientId();
  logInfo(`Client connected: ${clientId} (socket=${socket.id})`);
  
  // Store client information
  connectedClients.set(socket.id, {
    id: clientId,
    socketId: socket.id,
    isMaster: false,
    joinedAt: new Date(),
    lastActivity: new Date(),
    clientInfo: {},
    wantsToBeMaster: false,
    reconnected: false,
    previousClientId: null
  });
  
  // Send welcome message with client ID
  socket.emit('welcome', {
    clientId: clientId,
    serverTime: new Date().toISOString(),
    message: 'Terhubung ke TTS Multi-Master Server',
    totalClients: connectedClients.size,
    totalMasters: masterClients.size
  });
  
  // Send current connection status
  socket.emit('connection-status', {
    clientId: clientId,
    isMaster: masterClients.has(socket.id),
    totalClients: connectedClients.size,
    totalMasters: masterClients.size,
    masterList: Array.from(masterClients).map(sid => ({
      id: connectedClients.get(sid)?.id,
      socketId: sid
    })),
    connectedClients: getConnectedClientsSnapshot()
  });
  
  // Notify other clients about new connection
  socket.broadcast.emit('client-connected', {
    clientId: clientId,
    totalClients: connectedClients.size,
    totalMasters: masterClients.size,
    connectedClients: Array.from(connectedClients.values()).map(client => ({
      id: client.id,
      isMaster: client.isMaster
    }))
  });
  
  // Send master list to new client
  if (masterClients.size > 0) {
    socket.emit('master-list-updated', {
      masterList: getMasterListSnapshot(),
      totalMasters: masterClients.size
    });
  }
  
  // Handle client info update with master preference
  socket.on('client-info', (info) => {
    const client = connectedClients.get(socket.id);
    if (client) {
      client.clientInfo = { ...client.clientInfo, ...info };
      client.lastActivity = new Date();
      
      // Store previous client ID for reconnection
      if (info.savedClientId) {
        client.previousClientId = info.savedClientId;
        promotePreviousMasterRecord(client.id, info.savedClientId);
      }
      
      // Store if client wants to be master
      if (info.wantsToBeMaster !== undefined) {
        client.wantsToBeMaster = toBoolean(info.wantsToBeMaster);
        logInfo(`Client ${client.id} wantsToBeMaster=${client.wantsToBeMaster}`);
        
        // Track this preference for future reconnections
        previousMasters.set(client.id, {
          wantsToBeMaster: client.wantsToBeMaster,
          wasMaster: toBoolean(info.wasMaster),
          lastSeen: new Date()
        });
      }
      
      // Check if reconnecting client wants to be master and was master
      if (toBoolean(info.reconnected) && client.wantsToBeMaster) {
        logInfo(`Reconnect request from ${client.id}: wantsMaster=${client.wantsToBeMaster}, wasMaster=${toBoolean(info.wasMaster)}`);
        
        if (toBoolean(info.wasMaster)) {
          // This client was a master before disconnection
          logInfo(`Restoring previous master role for ${client.id}`);
          
          // Check if there are other masters
          if (masterClients.size > 0) {
            // In multi-master mode, just add this client back
            if (!masterClients.has(socket.id)) {
              masterClients.add(socket.id);
              client.isMaster = true;
              client.wantsToBeMaster = true;
              
              socket.emit('master-role-granted', { 
                isMaster: true,
                clientId: client.id,
                message: 'Anda kembali sebagai Master Controller (Multi-Master)',
                autoReconnected: true,
                wasMaster: true,
                totalMasters: masterClients.size
              });
              
              io.emit('master-added', { 
                masterClientId: client.id,
                masterSocketId: socket.id,
                timestamp: new Date().toISOString(),
                totalMasters: masterClients.size,
                masterList: getMasterListSnapshot(),
                reason: 'auto-reconnect-was-master'
              });
              
              logInfo(`Restored master role for ${client.id} in multi-master mode`);
            }
          } else {
            // No masters currently, restore this client as master
            if (!masterClients.has(socket.id)) {
              masterClients.add(socket.id);
              client.isMaster = true;
              client.wantsToBeMaster = true;
              
              socket.emit('master-role-granted', { 
                isMaster: true,
                clientId: client.id,
                message: 'Anda kembali sebagai Master Controller',
                autoReconnected: true,
                wasMaster: true,
                totalMasters: masterClients.size
              });
              
              io.emit('master-added', { 
                masterClientId: client.id,
                masterSocketId: socket.id,
                timestamp: new Date().toISOString(),
                totalMasters: masterClients.size,
                masterList: getMasterListSnapshot(),
                reason: 'auto-reconnect-no-masters'
              });
              
              logInfo(`Restored master role for ${client.id} as first active master`);
            }
          }
        } else if (masterClients.size === 0) {
          // Client wants to be master and no masters available
          logInfo(`Granting master to ${client.id} because no masters are active`);
          
          masterClients.add(socket.id);
          client.isMaster = true;
          client.wantsToBeMaster = true;
          
          socket.emit('master-role-granted', { 
            isMaster: true,
            clientId: client.id,
            message: 'Anda menjadi Master Controller',
            autoReconnected: true,
            wasMaster: false,
            totalMasters: masterClients.size
          });
          
          io.emit('master-added', { 
            masterClientId: client.id,
            masterSocketId: socket.id,
            timestamp: new Date().toISOString(),
            totalMasters: masterClients.size,
            masterList: getMasterListSnapshot(),
            reason: 'auto-reconnect-requested'
          });
        }
      }
    }
  });
  
  // Handle request to become master
  socket.on('request-master-role', async (data = {}) => {
    const client = connectedClients.get(socket.id);
    logInfo(`Master role requested by ${client?.id || socket.id}`);

    if (!client) {
      emitSocketError(socket, 'master-role-denied', 'Client tidak terdaftar atau koneksi sudah tidak aktif', {
        reason: 'Client tidak terdaftar atau koneksi sudah tidak aktif'
      });
      return;
    }
    
    // Update client preference
    if (client) {
      client.wantsToBeMaster = toBoolean(data.wantsToBeMaster);
      
      // Track preference for reconnection
      previousMasters.set(client.id, {
        wantsToBeMaster: client.wantsToBeMaster,
        wasMaster: true,
        lastSeen: new Date()
      });
    }
    
    // Add to masters if not already a master
    if (!masterClients.has(socket.id)) {
      masterClients.add(socket.id);
      client.isMaster = true;
      client.wantsToBeMaster = true;
      
      socket.emit('master-role-granted', { 
        isMaster: true,
        clientId: client.id,
        message: 'Anda sekarang adalah Master Controller',
        autoReconnected: data.autoReconnect || false,
        totalMasters: masterClients.size
      });
      
      io.emit('master-added', { 
        masterClientId: client.id,
        masterSocketId: socket.id,
        timestamp: new Date().toISOString(),
        totalMasters: masterClients.size,
        masterList: getMasterListSnapshot(),
        reason: 'manual-request'
      });
      
      logInfo(`Client ${client.id} added to masters: total=${masterClients.size}`);
      
      if (masterRequestQueue.length > 0) {
        await processQueuedMasterRequests();
      }
    } else {
      // Already a master
      emitSocketError(socket, 'master-role-duplicate', 'Anda sudah menjadi Master Controller', {
        message: 'Anda sudah menjadi Master Controller',
        totalMasters: masterClients.size
      });
    }
  });
  
  // Handle release master role
  socket.on('release-master-role', (data) => {
    const client = connectedClients.get(socket.id);
    if (!client) return;
    
    if (masterClients.has(socket.id)) {
      // Remove from masters
      masterClients.delete(socket.id);
      client.isMaster = false;
      
      // Update preference if specified
      if (data && toBoolean(data.clearPreference)) {
        client.wantsToBeMaster = false;
        // Remove from previous masters tracking
        previousMasters.delete(client.id);
      } else {
        // Still wants to be master in future
        previousMasters.set(client.id, {
          wantsToBeMaster: true,
          wasMaster: false,
          lastSeen: new Date()
        });
      }
      
      io.emit('master-removed', {
        removedMasterId: client.id,
        timestamp: new Date().toISOString(),
        totalMasters: masterClients.size,
        masterList: getMasterListSnapshot()
      });
      
      socket.emit('master-role-released', {
        isMaster: false,
        message: 'Anda telah melepaskan peran master',
        totalMasters: masterClients.size,
        preferenceCleared: data ? toBoolean(data.clearPreference) : false
      });
      
      logInfo(`Client ${client.id} removed from masters: total=${masterClients.size}`);
    }
  });
  
  // Handle request to get master list
  socket.on('get-master-list', () => {
    const masterList = Array.from(masterClients).map(sid => ({
      id: connectedClients.get(sid)?.id,
      socketId: sid,
      joinedAt: connectedClients.get(sid)?.joinedAt
    }));
    
    socket.emit('master-list-response', {
      masterList: masterList,
      totalMasters: masterClients.size,
      timestamp: new Date().toISOString()
    });
  });
  
  // Handle TTS request from clients (HANYA KE SEMUA MASTER)
  socket.on('tts-request', async (data = {}) => {
    const client = connectedClients.get(socket.id);
    const { text, language = 'id-ID', speed = 1.0, priority = 'normal' } = data;
    
    logInfo(`TTS request from ${client?.id || socket.id}: language=${language}, textLength=${text?.length || 0}`);
    
    try {
      if (!client) {
        emitSocketError(socket, 'tts-error', 'Client tidak valid atau koneksi sudah berakhir');
        return;
      }

      // Validasi input dengan detail
      if (!text || typeof text !== 'string') {
        emitSocketError(socket, 'tts-error', 'Teks harus berupa string', getSchedulerContext(data));
        return;
      }
      
      const trimmedText = text.trim();
      if (trimmedText.length === 0) {
        emitSocketError(socket, 'tts-error', 'Teks tidak boleh kosong atau hanya spasi', getSchedulerContext(data));
        return;
      }
      
      if (text.length > MAX_TTS_TEXT_LENGTH) {
        emitSocketError(socket, 'tts-error', `Teks terlalu panjang (${text.length} karakter). Maksimal ${MAX_TTS_TEXT_LENGTH} karakter.`, {
          suggestion: 'Coba bagi teks menjadi beberapa bagian',
          ...getSchedulerContext(data)
        });
        return;
      }
      
      // If no masters, queue the request
      if (masterClients.size === 0) {
        const queuedForClient = masterRequestQueue.filter((request) => request.fromClientSocketId === socket.id).length;
        const maxQueuedPerClient = parseInt(process.env.MAX_QUEUE_PER_CLIENT, 10) || 5;

        if (masterRequestQueue.length >= MAX_QUEUE_LENGTH) {
          emitSocketError(socket, 'tts-error', `Antrian TTS penuh (${MAX_QUEUE_LENGTH} permintaan). Coba lagi setelah master aktif.`, {
            queueFull: true,
            pendingRequests: masterRequestQueue.length,
            ...getSchedulerContext(data)
          });
          return;
        }

        if (queuedForClient >= maxQueuedPerClient) {
          emitSocketError(socket, 'tts-error', `Terlalu banyak permintaan dalam antrian untuk client ini. Maksimal ${maxQueuedPerClient}.`, {
            queueFull: true,
            queuedForClient,
            ...getSchedulerContext(data)
          });
          return;
        }

        masterRequestQueue.push({
          ...data,
          text: trimmedText,
          fromClientId: client.id,
          fromClientSocketId: socket.id,
          timestamp: new Date().toISOString(),
          priority: priority
        });
        
        socket.emit('tts-queued', {
          success: true,
          message: 'TTS request dalam antrian. Menunggu master controller...',
          queuePosition: masterRequestQueue.length,
          textLength: text.length,
          schedulerId: data.schedulerId || null,
          schedulerName: data.schedulerName || null,
          schedulerItem: data.schedulerItem || null
        });
        
        io.emit('master-needed', {
          message: 'Master controller diperlukan untuk memproses TTS request',
          pendingRequests: masterRequestQueue.length
        });
        
        return;
      }
      
      // Convert text to speech
      const result = await googleTTSService.convertTextToSpeech({
        text: trimmedText,
        language: language,
        speed: normalizeSpeed(speed)
      });
      
      // Kirim ke semua master dengan satu request ID agar status playback dapat dilacak.
      emitTtsAudioToMasters(result, {
        ...data,
        fromClientId: client.id,
        fromClientSocketId: socket.id,
        priority
      });
      
      socket.emit('tts-complete', {
        success: true,
        message: `Audio telah dikirim ke ${masterClients.size} Master Controller`,
        masterCount: masterClients.size,
        textLength: text.length,
        language: language,
        duration: result.duration,
        schedulerId: data.schedulerId || null,
        schedulerName: data.schedulerName || null,
        schedulerItem: data.schedulerItem || null,
        schedulerRunId: data.schedulerRunId || null
      });
      
      // Notify all clients about new TTS (except sender)
      socket.broadcast.emit('tts-notification', {
        fromClientId: client.id,
        textPreview: text.length > 50 ? text.substring(0, 50) + '...' : text,
        language: language,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logError(`TTS error for ${client?.id || socket.id}`, error.message);
      
      let userMessage = 'Gagal mengonversi teks ke suara';
      let suggestion = 'Coba gunakan teks yang lebih pendek atau bahasa lain';
      
      if (error.message.includes('Rate limit')) {
        userMessage = 'Terlalu banyak permintaan ke Google TTS';
        suggestion = 'Tunggu beberapa menit sebelum mencoba lagi';
      } else if (error.message.includes('Timeout')) {
        userMessage = 'Google TTS tidak merespons';
        suggestion = 'Coba lagi dalam beberapa saat';
      } else if (error.message.includes('kosong')) {
        userMessage = error.message;
        suggestion = 'Pastikan teks tidak kosong';
      } else if (error.message.includes('panjang')) {
        userMessage = error.message;
        suggestion = 'Coba bagi teks menjadi beberapa bagian (maksimal 5000 karakter)';
      }
      
      emitSocketError(socket, 'tts-error', `${userMessage} (Detail: ${error.message})`, {
        suggestion,
        schedulerId: data.schedulerId || null,
        schedulerName: data.schedulerName || null,
        schedulerItem: data.schedulerItem || null,
        schedulerRunId: data.schedulerRunId || null
      });
    }
  });

  // Handle file audio yang sebelumnya sudah di-upload oleh scheduler.
  socket.on('audio-request', (data = {}) => {
    const client = connectedClients.get(socket.id);

    try {
      if (!client) {
        emitSocketError(socket, 'audio-error', 'Client tidak valid atau koneksi sudah berakhir');
        return;
      }

      const sourceType = data.sourceType === 'voice-note' ? 'voice-note' : 'upload';
      const sourceLabel = sourceType === 'voice-note' ? 'Voice note' : 'Audio upload';

      const uploadedAudio = getUploadedAudio(data.audioUrl);
      if (!uploadedAudio) {
        emitSocketError(socket, 'audio-error', 'File audio upload tidak ditemukan atau URL tidak valid', {
          sourceType,
          schedulerId: data.schedulerId || null,
          schedulerName: data.schedulerName || null,
          schedulerItem: data.schedulerItem || null,
          schedulerRunId: data.schedulerRunId || null
        });
        return;
      }

      const request = {
        ...data,
        kind: 'audio',
        audioUrl: uploadedAudio.audioUrl,
        fromClientId: client.id,
        fromClientSocketId: socket.id,
        timestamp: new Date().toISOString(),
        priority: data.priority || 'normal',
        sourceType
      };

      if (masterClients.size === 0) {
        const queuedForClient = masterRequestQueue.filter((item) => item.fromClientSocketId === socket.id).length;
        const maxQueuedPerClient = parseInt(process.env.MAX_QUEUE_PER_CLIENT, 10) || 5;

        if (masterRequestQueue.length >= MAX_QUEUE_LENGTH || queuedForClient >= maxQueuedPerClient) {
          emitSocketError(socket, 'audio-error', 'Antrian audio penuh. Coba lagi setelah Master aktif.', {
            queueFull: true,
            sourceType,
            ...getSchedulerContext(data)
          });
          return;
        }

        masterRequestQueue.push(request);
        socket.emit('audio-queued', {
          success: true,
          message: `${sourceLabel} masuk antrian. Menunggu Master Controller...`,
          queuePosition: masterRequestQueue.length,
          sourceType,
          schedulerId: data.schedulerId || null,
          schedulerName: data.schedulerName || null,
          schedulerItem: data.schedulerItem || null,
          schedulerRunId: data.schedulerRunId || null
        });
        io.emit('master-needed', {
          message: 'Master controller diperlukan untuk memproses audio',
          pendingRequests: masterRequestQueue.length
        });
        return;
      }

      emitUploadedAudioToMasters(request);
      socket.emit('audio-complete', {
        success: true,
        message: `${sourceLabel} telah dikirim ke ${masterClients.size} Master Controller`,
        masterCount: masterClients.size,
        sourceType,
        schedulerId: data.schedulerId || null,
        schedulerName: data.schedulerName || null,
        schedulerItem: data.schedulerItem || null,
        schedulerRunId: data.schedulerRunId || null
      });
    } catch (error) {
      logError(`Uploaded audio error for ${client?.id || socket.id}`, error.message);
      emitSocketError(socket, 'audio-error', `Gagal mengirim audio (Detail: ${error.message})`, {
        sourceType: data.sourceType === 'voice-note' ? 'voice-note' : 'upload',
        schedulerId: data.schedulerId || null,
        schedulerName: data.schedulerName || null,
        schedulerItem: data.schedulerItem || null,
        schedulerRunId: data.schedulerRunId || null
      });
    }
  });
  
  // Handle client requesting to play audio (master only)
  socket.on('play-audio', () => {
    if (masterClients.has(socket.id)) {
      emitSocketError(socket, 'play-audio-denied', 'Fitur broadcast audio tidak tersedia', {
        reason: 'Fitur broadcast audio tidak tersedia'
      });
    } else {
      emitSocketError(socket, 'play-audio-denied', 'Hanya Master Controller yang dapat mengontrol pemutaran audio', {
        reason: 'Hanya Master Controller yang dapat mengontrol pemutaran audio'
      });
    }
  });
  
  // Handle client requesting to stop audio
  socket.on('stop-audio', () => {
    if (masterClients.has(socket.id)) {
      // Hanya berhenti di master itu sendiri
      socket.emit('stop-audio-command', {
        issuedBy: connectedClients.get(socket.id)?.id,
        timestamp: new Date().toISOString(),
        fromMaster: true
      });
    }
  });
  
  // Handle audio playback status
  socket.on('audio-status', (statusData) => {
    const client = connectedClients.get(socket.id);
    const playbackStatus = typeof statusData === 'string' ? statusData : statusData?.status;
    const requestId = typeof statusData === 'object' ? statusData?.requestId : null;

    if (
      masterClients.has(socket.id)
      && requestId
      && ['ended', 'stopped', 'interrupted', 'error', 'master-disconnected'].includes(playbackStatus)
    ) {
      completeSchedulerPlayback(requestId, playbackStatus, socket.id);
    }

    io.emit('client-audio-status', {
      clientId: client?.id || null,
      status: playbackStatus || 'unknown',
      requestId: requestId || null,
      timestamp: new Date().toISOString()
    });
  });
  
  // Handle ping from client
  socket.on('ping', (data) => {
    const client = connectedClients.get(socket.id);
    if (client) {
      client.lastActivity = new Date();
    }
    socket.emit('pong', {
      serverTime: new Date().toISOString(),
      clientId: client?.id,
      totalMasters: masterClients.size,
      totalClients: connectedClients.size
    });
  });
  
  // Handle disconnect with auto-reconnect data
  socket.on('disconnect', (reason) => {
    const client = connectedClients.get(socket.id);
    logInfo(`Client disconnected: ${client?.id || socket.id}, reason=${reason}`);

    pendingSchedulerPlaybacks.forEach((pending, requestId) => {
      if (pending.fromClientSocketId === socket.id) {
        clearTimeout(pending.timeout);
        pendingSchedulerPlaybacks.delete(requestId);
      }
    });
    
    // Save master preference for reconnection
    if (client && client.wantsToBeMaster) {
      previousMasters.set(client.id, {
        wantsToBeMaster: client.wantsToBeMaster,
        wasMaster: client.isMaster,
        lastSeen: new Date(),
        socketId: socket.id
      });
    }
    
    // If master disconnects, remove from masters
    if (masterClients.has(socket.id)) {
      const wasMaster = true;
      masterClients.delete(socket.id);

      // Finish scheduler items that no longer have any master able to play them.
      pendingSchedulerPlaybacks.forEach((pending, requestId) => {
        if (!pending.masterSocketIds) return;
        pending.masterSocketIds.delete(socket.id);
        if (pending.masterSocketIds.size === 0) {
          completeSchedulerPlayback(requestId, 'master-disconnected', socket.id);
        }
      });
      
      io.emit('master-disconnected', {
        disconnectedMasterId: client?.id,
        wantsToBeMaster: client?.wantsToBeMaster || false,
        wasMaster: wasMaster,
        timestamp: new Date().toISOString(),
        totalMasters: masterClients.size,
        masterList: getMasterListSnapshot(),
        message: 'Master Controller terputus.'
      });
      
      // Clear master queue if no masters left
      if (masterClients.size === 0 && masterRequestQueue.length > 0) {
        masterRequestQueue.forEach(request => {
          io.emit('tts-request-cancelled', {
            request: request,
            reason: 'Semua Master Controller terputus'
          });
        });
        masterRequestQueue = [];
      }
    }
    
    // Remove from connected clients
    connectedClients.delete(socket.id);
    
    // Notify remaining clients
    io.emit('client-disconnected', {
      clientId: client?.id,
      totalClients: connectedClients.size,
      totalMasters: masterClients.size,
      reason: reason,
      connectedClients: Array.from(connectedClients.values()).map(c => ({
        id: c.id,
        isMaster: c.isMaster
      }))
    });
  });
  
  // Handle errors
  socket.on('error', (error) => {
    logError(`Socket error for ${clientId}`, error);
  });
});

// Clean up inactive clients periodically
setInterval(() => {
  const now = new Date();
  const inactiveThreshold = 5 * 60 * 1000; // 5 minutes
  
  connectedClients.forEach((client, socketId) => {
    if (now - client.lastActivity > inactiveThreshold) {
      logInfo(`Removing inactive client: ${client.id}`);
      
      if (masterClients.has(socketId)) {
        masterClients.delete(socketId);
        io.emit('master-inactive', {
          inactiveClientId: client.id,
          timestamp: now.toISOString(),
          totalMasters: masterClients.size
        });
      }
      
      connectedClients.delete(socketId);
      io.in(socketId).disconnectSockets(true);
    }
  });
}, 60 * 1000); // Check every minute

// API Routes
app.post(
  '/api/audio/upload',
  requireClientSession,
  limitAudioUploads,
  express.raw({ type: () => true, limit: MAX_UPLOAD_AUDIO_SIZE }),
  async (req, res) => {
    const requestedContentType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();

    if (!supportedAudioTypes.has(requestedContentType)) {
      return sendApiError(res, 415, 'Format audio tidak didukung. Gunakan MP3, WAV, OGG, WebM, M4A, AAC, atau FLAC.');
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return sendApiError(res, 400, 'File audio kosong');
    }

    let inspectedAudio;
    try {
      inspectedAudio = await inspectAudioUpload(req.body);
    } catch (error) {
      logInfo(`Rejected audio upload from ${req.ip || 'unknown'}: ${error.message}`);
      return sendApiError(res, 400, 'File audio tidak valid atau tidak memiliki stream audio yang dapat diputar');
    }

    if (uploadStorageSize + req.body.length > MAX_UPLOAD_STORAGE_SIZE) {
      return sendApiError(res, 507, `Penyimpanan audio penuh. Batas total ${MAX_UPLOAD_STORAGE_MB} MB.`);
    }

    const filename = `audio_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${inspectedAudio.extension}`;
    const filePath = path.join(UPLOAD_DIR, filename);
    uploadStorageSize += req.body.length;
    try {
      await fs.promises.writeFile(filePath, req.body, { flag: 'wx' });
    } catch (error) {
      uploadStorageSize -= req.body.length;
      throw error;
    }

    let originalName = 'Audio upload';
    try {
      originalName = path.basename(decodeURIComponent(req.get('x-audio-name') || originalName))
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 160) || 'Audio upload';
    } catch (error) {
      originalName = 'Audio upload';
    }

    return res.status(201).json({
      success: true,
      audioUrl: `/api/audio/files/${filename}`,
      fileName: originalName,
      size: req.body.length,
      format: inspectedAudio.contentType,
      maxSizeMb: MAX_UPLOAD_AUDIO_SIZE_MB
    });
  }
);

app.get('/api/audio/files/:filename', (req, res) => {
  const uploadedAudio = getUploadedAudio(`/api/audio/files/${req.params.filename}`);
  if (!uploadedAudio) {
    return sendApiError(res, 404, 'File audio tidak ditemukan');
  }

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'public, max-age=86400');
  res.type(uploadedAudio.contentType);
  return res.sendFile(uploadedAudio.filePath);
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Multi-Master TTS Server v3.0',
    serverUptime: process.uptime(),
    connectedClients: connectedClients.size,
    totalMasters: masterClients.size,
    pendingRequests: masterRequestQueue.length,
    memoryUsage: process.memoryUsage()
  });
});

app.get('/api/clients', (req, res) => {
  res.json({
    success: true,
    totalClients: connectedClients.size,
    totalMasters: masterClients.size,
    pendingRequests: masterRequestQueue.length,
    clients: getConnectedClientsSnapshot()
  });
});

app.get('/api/masters', (req, res) => {
  const masters = Array.from(masterClients).map(socketId => {
    const client = connectedClients.get(socketId);
    return {
      id: client?.id,
      socketId: socketId,
      joinedAt: client?.joinedAt,
      lastActivity: client?.lastActivity,
      clientInfo: client?.clientInfo
    };
  });
  
  res.json({
    success: true,
    totalMasters: masterClients.size,
    masters: masters
  });
});

app.post('/api/add-master', requireAdminToken, (req, res) => {
  const { clientId } = req.body;
  
  if (!clientId) {
    return sendApiError(res, 400, 'clientId diperlukan');
  }
  
  // Find client by ID
  const targetClient = findClientRecordById(clientId);

  if (!targetClient) {
    return sendApiError(res, 404, 'Client tidak ditemukan');
  }
  
  // Add to masters if not already a master
  if (!masterClients.has(targetClient.socketId)) {
    masterClients.add(targetClient.socketId);
    targetClient.client.isMaster = true;
    targetClient.client.wantsToBeMaster = true;
    
    // Track for reconnection
    previousMasters.set(clientId, {
      wantsToBeMaster: true,
      wasMaster: true,
      lastSeen: new Date()
    });
    
    // Notify client
    io.to(targetClient.socketId).emit('master-role-granted', {
      isMaster: true,
      clientId: clientId,
      message: 'Anda ditambahkan sebagai Master Controller oleh admin',
      totalMasters: masterClients.size
    });
    
    // Notify all
    io.emit('master-added', {
      masterClientId: clientId,
      masterSocketId: targetClient.socketId,
      timestamp: new Date().toISOString(),
      totalMasters: masterClients.size,
      masterList: getMasterListSnapshot(),
      addedBy: 'api'
    });

    processQueuedMasterRequests().catch((error) => {
      logError('Failed to process queued requests after API add-master', error.message);
    });
    
    res.json({
      success: true,
      message: `Client ${clientId} ditambahkan sebagai Master Controller`,
      totalMasters: masterClients.size
    });
  } else {
    sendApiError(res, 409, `Client ${clientId} sudah menjadi Master Controller`);
  }
});

app.post('/api/remove-master', requireAdminToken, (req, res) => {
  const { clientId } = req.body;
  
  if (!clientId) {
    return sendApiError(res, 400, 'clientId diperlukan');
  }
  
  // Find client by ID
  const targetClient = findClientRecordById(clientId);

  if (!targetClient) {
    return sendApiError(res, 404, 'Client tidak ditemukan');
  }
  
  // Remove from masters if exists
  if (masterClients.has(targetClient.socketId)) {
    masterClients.delete(targetClient.socketId);
    targetClient.client.isMaster = false;
    
    // Update previous masters tracking
    previousMasters.set(clientId, {
      wantsToBeMaster: false,
      wasMaster: false,
      lastSeen: new Date()
    });
    
    // Notify client
    io.to(targetClient.socketId).emit('master-role-removed', {
      isMaster: false,
      clientId: clientId,
      message: 'Anda dikeluarkan dari Master Controller oleh admin',
      totalMasters: masterClients.size
    });
    
    // Notify all
    io.emit('master-removed', {
      removedMasterId: clientId,
      timestamp: new Date().toISOString(),
      totalMasters: masterClients.size,
      masterList: getMasterListSnapshot(),
      removedBy: 'api'
    });
    
    res.json({
      success: true,
      message: `Client ${clientId} dikeluarkan dari Master Controller`,
      totalMasters: masterClients.size
    });
  } else {
    sendApiError(res, 409, `Client ${clientId} bukan Master Controller`);
  }
});

app.post('/api/clear-queue', requireAdminToken, (req, res) => {
  const cleared = masterRequestQueue.length;
  masterRequestQueue = [];
  
  io.emit('queue-cleared', {
    clearedCount: cleared,
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: `Berhasil menghapus ${cleared} permintaan dari antrian`
  });
});

app.get('/api/languages', (req, res) => {
  try {
    const languages = googleTTSService.getSupportedLanguages();
    res.json({
      success: true,
      languages: languages
    });
  } catch (error) {
    sendApiError(res, 500, 'Gagal mengambil daftar bahasa');
  }
});

app.post('/api/tts', requireAdminToken, async (req, res) => {
  try {
    const { text, language = 'id-ID', speed = 1.0 } = req.body;
    
    logInfo(`API TTS request: language=${language}, textLength=${text?.length || 0}`);
    
    if (!text || typeof text !== 'string') {
      return sendApiError(res, 400, 'Text harus berupa string');
    }
    
    if (text.trim().length === 0) {
      return sendApiError(res, 400, 'Text tidak boleh kosong atau hanya spasi');
    }
    
    if (text.length > MAX_TTS_TEXT_LENGTH) {
      return sendApiError(res, 400, `Text terlalu panjang (${text.length} karakter). Maksimal ${MAX_TTS_TEXT_LENGTH} karakter.`, {
        suggestion: 'Coba bagi teks menjadi beberapa bagian'
      });
    }

    if (masterClients.size === 0) {
      return sendApiError(res, 503, 'Tidak ada Master Controller yang terhubung', {
        clientCount: connectedClients.size
      });
    }
    
    const validSpeed = normalizeSpeed(speed);
    
    logInfo(`API TTS request details: language=${language}, speed=${validSpeed}, textLength=${text.length}`);
    
    const result = await googleTTSService.convertTextToSpeech({
      text: text,
      language: language,
      speed: validSpeed
    });
    
    masterClients.forEach(masterSocketId => {
      io.to(masterSocketId).emit('tts-audio', {
        ...result,
        fromClientId: 'api-request',
        timestamp: new Date().toISOString(),
        priority: 'high',
        forMasterOnly: true,
        masterCount: masterClients.size
      });
    });

    res.json({
      ...result,
      totalMasters: masterClients.size,
      clientCount: connectedClients.size
    });
    
  } catch (error) {
    logError('API TTS error', error.message);
    
    let errorMessage = error.message || 'Terjadi kesalahan pada server';
    let suggestion = 'Coba kurangi panjang teks atau ganti bahasa';
    
    if (error.message.includes('Rate limit')) {
      errorMessage = 'Terlalu banyak permintaan. Silakan coba lagi nanti.';
      suggestion = 'Tunggu 15 menit sebelum mengirim permintaan lagi';
    } else if (error.message.includes('Timeout')) {
      errorMessage = 'Server Google TTS tidak merespons.';
      suggestion = 'Coba lagi dalam beberapa saat';
    } else if (error.message.includes('kosong')) {
      errorMessage = error.message;
      suggestion = 'Pastikan Anda memasukkan teks yang valid';
    }
    
    sendApiError(res, 500, errorMessage, { suggestion });
  }
});

app.get('/api/test', async (req, res) => {
  try {
    const testResult = await googleTTSService.testConnection();
    res.json(testResult);
  } catch (error) {
    sendApiError(res, 500, error.message);
  }
});

app.get('/api/stats', (req, res) => {
  const stats = {
    connectedClients: connectedClients.size,
    totalMasters: masterClients.size,
    pendingRequests: masterRequestQueue.length,
    serverUptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    activeSince: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    previousMastersCount: previousMasters.size
  };
  
  res.json({
    success: true,
    stats: stats
  });
});

app.get('/api/client-status/:clientId', (req, res) => {
  const { clientId } = req.params;

  const targetClient = findClientRecordById(clientId);
  
  res.json({
    success: true,
    clientId: clientId,
    isMaster: targetClient ? masterClients.has(targetClient.socketId) : false,
    socketId: targetClient?.socketId || null,
    exists: Boolean(targetClient),
    totalMasters: masterClients.size,
    previousMasterData: previousMasters.get(clientId) || null
  });
});

app.get('/api/master-preference/:clientId', (req, res) => {
  const { clientId } = req.params;

  const targetClient = findClientRecordById(clientId);

  if (targetClient) {
    res.json({
      success: true,
      clientId: clientId,
      wantsToBeMaster: targetClient.client.wantsToBeMaster || false,
      isMaster: targetClient.client.isMaster || false,
      previousMasterData: previousMasters.get(clientId) || null
    });
  } else {
    sendApiError(res, 404, 'Client tidak ditemukan', { clientId });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logError('Server error', err.stack);
  if (err.type === 'entity.too.large') {
    return sendApiError(res, 413, `File audio terlalu besar. Maksimal ${MAX_UPLOAD_AUDIO_SIZE_MB} MB.`);
  }
  sendApiError(res, 500, 'Terjadi kesalahan internal server', {
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  sendApiError(res, 404, 'Endpoint tidak ditemukan');
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${PORT}`;

  console.log('\n========================================');
  console.log('   Multi-Master TTS Server v3.0');
  console.log(`   Berjalan di: ${serverUrl}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log('   Socket.IO active');
  console.log(`   Tanggal: ${new Date().toLocaleString()}`);
  console.log('========================================\n');

  console.log('Socket.IO siap menerima koneksi');
  console.log('\nAPI Endpoints:');
  console.log(`   GET  ${serverUrl}/api/health      - Cek status server & client`);
  console.log(`   GET  ${serverUrl}/api/clients     - Daftar client terhubung`);
  console.log(`   GET  ${serverUrl}/api/masters     - Daftar master aktif`);
  console.log(`   GET  ${serverUrl}/api/stats       - Statistik server`);
  console.log(`   POST ${serverUrl}/api/add-master  - Tambah client sebagai master`);
  console.log(`   POST ${serverUrl}/api/tts         - Konversi teks ke suara`);
  console.log(`   POST ${serverUrl}/api/audio/upload - Upload audio scheduler`);
  console.log(`   GET  ${serverUrl}/api/languages   - Daftar bahasa yang didukung`);
  console.log(`   POST ${serverUrl}/api/clear-queue - Hapus antrian TTS`);
  console.log(`   GET  ${serverUrl}/api/client-status/:clientId - Cek status client`);

  console.log(`\nFrontend tersedia di: ${serverUrl}`);
  console.log('\nFitur: Multi-Master TTS');
  console.log(' - Multiple master dapat aktif bersamaan');
  console.log(' - Client selalu kirim ke semua master');
  console.log(' - Tidak ada broadcast atau spesifik master');
  console.log(' - Master preference disimpan di localStorage');
  console.log(' - Auto-reconnect saat browser di-refresh');
  console.log(' - Master tetap stabil setelah refresh');
  console.log('\n========================================\n');
});
