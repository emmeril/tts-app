require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const googleTTSService = require('./services/googleTTSService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // Izinkan semua origin
    methods: ['GET', 'POST'],
    credentials: false
  },
  pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT) || 5000,
  pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL) || 25000,
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

// Middleware - Hapus CORS atau izinkan semua
app.use(cors({
  origin: "*", // Izinkan semua origin
  credentials: false
}));
app.use(morgan(process.env.LOG_LEVEL || 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from frontend directory
app.use(express.static(path.join(__dirname, '../frontend')));

// Store connected clients and their info
const connectedClients = new Map();
let masterClient = null;
let masterRequestQueue = [];

// Master recovery system
const masterHistory = new Map();
const masterRecoveryQueue = new Map();

// Generate unique client ID with short version
const generateClientId = () => {
  const id = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const shortId = id.substring(0, 8); // ID pendek
  return { id, shortId };
};

// Get short ID from full ID
const getShortId = (fullId) => {
  return fullId ? fullId.substring(0, 8) : 'unknown';
};

// Check if client is previous master
const isPreviousMaster = (clientId) => {
  return masterHistory.has(clientId);
};

// Add client to master history
const addToMasterHistory = (clientId, shortId) => {
  masterHistory.set(clientId, {
    shortId: shortId,
    firstBecameMaster: new Date(),
    lastBecameMaster: new Date(),
    timesMaster: (masterHistory.get(clientId)?.timesMaster || 0) + 1,
    lastDisconnect: null,
    recoveryAttempts: 0
  });
};

// Update master history on disconnect
const updateMasterHistoryOnDisconnect = (clientId) => {
  const history = masterHistory.get(clientId);
  if (history) {
    history.lastDisconnect = new Date();
  }
};

// Clean old master history
const cleanOldMasterHistory = () => {
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  
  for (const [clientId, history] of masterHistory.entries()) {
    if (history.lastDisconnect && history.lastDisconnect < oneHourAgo) {
      masterHistory.delete(clientId);
    }
  }
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  const { id: clientId, shortId: shortClientId } = generateClientId();
  console.log(`[${new Date().toISOString()}] Client connected: ${shortClientId} (Full: ${clientId}, Socket: ${socket.id})`);
  
  // Check if this is a returning master
  const isReturningMaster = isPreviousMaster(clientId);
  
  // Store client information
  connectedClients.set(socket.id, {
    id: clientId,
    shortId: shortClientId,
    socketId: socket.id,
    isMaster: false,
    joinedAt: new Date(),
    lastActivity: new Date(),
    clientInfo: {},
    isReturningMaster: isReturningMaster
  });
  
  // Send welcome message with client ID
  socket.emit('welcome', {
    clientId: clientId,
    shortClientId: shortClientId,
    serverTime: new Date().toISOString(),
    message: 'Terhubung ke TTS Multi-Client Server',
    totalClients: connectedClients.size,
    hasMaster: !!masterClient,
    masterShortId: masterClient ? connectedClients.get(masterClient)?.shortId : null,
    supportsRecovery: true,
    isReturningMaster: isReturningMaster
  });
  
  // Send current connection status
  socket.emit('connection-status', {
    clientId: clientId,
    shortClientId: shortClientId,
    isMaster: masterClient === socket.id,
    totalClients: connectedClients.size,
    masterClient: masterClient ? connectedClients.get(masterClient)?.id : null,
    masterShortId: masterClient ? connectedClients.get(masterClient)?.shortId : null,
    connectedClients: Array.from(connectedClients.values()).map(client => ({
      id: client.id,
      shortId: client.shortId,
      isMaster: client.isMaster,
      joinedAt: client.joinedAt
    }))
  });
  
  // Notify other clients about new connection
  socket.broadcast.emit('client-connected', {
    clientId: clientId,
    shortClientId: shortClientId,
    totalClients: connectedClients.size,
    connectedClients: Array.from(connectedClients.values()).map(client => ({
      id: client.id,
      shortId: client.shortId,
      isMaster: client.isMaster
    }))
  });
  
  // Handle client info update
  socket.on('client-info', (info) => {
    const client = connectedClients.get(socket.id);
    if (client) {
      client.clientInfo = { ...client.clientInfo, ...info };
      client.lastActivity = new Date();
      
      // Check if this is a master recovery attempt
      if (info.wasMaster && !masterClient) {
        // Notify client that recovery is available
        socket.emit('master-recovery-available', {
          message: 'Recovery Master tersedia',
          wasMaster: true,
          recoveryAttempts: info.recoveryAttempts || 0
        });
      }
    }
  });
  
  // Handle request to become master
  socket.on('request-master-role', (data) => {
    const client = connectedClients.get(socket.id);
    console.log(`[${new Date().toISOString()}] Master role requested by: ${client?.shortId}, Recovery: ${data.isRecoveryAttempt || false}`);
    
    // Check jika ini recovery attempt
    const isRecovery = data.isRecoveryAttempt || false;
    
    // Check if master already exists
    if (masterClient && masterClient !== socket.id) {
      const currentMaster = connectedClients.get(masterClient);
      
      // Jika ini recovery attempt, beri informasi lebih detail
      socket.emit('master-role-denied', {
        reason: 'Master controller sudah ada',
        currentMasterId: currentMaster?.id,
        currentMasterShortId: currentMaster?.shortId,
        suggestion: 'Tunggu hingga master saat ini melepaskan peran atau terputus',
        isRecoveryAttempt: isRecovery
      });
      return;
    }
    
    // Grant master role
    masterClient = socket.id;
    connectedClients.get(socket.id).isMaster = true;
    
    // Add to master history
    addToMasterHistory(client.id, client.shortId);
    
    // Update recovery attempts if this is a recovery
    if (isRecovery) {
      const history = masterHistory.get(client.id);
      if (history) {
        history.recoveryAttempts = (history.recoveryAttempts || 0) + 1;
        history.lastBecameMaster = new Date();
      }
      
      console.log(`[${new Date().toISOString()}] Master recovery successful for: ${client.shortId}`);
    }
    
    socket.emit('master-role-granted', { 
      isMaster: true,
      clientId: client.id,
      shortClientId: client.shortId,
      message: isRecovery ? 
        'Status Master berhasil dikembalikan!' : 
        'Anda sekarang adalah Master Controller',
      isRecovery: isRecovery
    });
    
    // Notify all clients with short IDs
    io.emit('master-changed', { 
      masterClientId: client.id,
      masterShortId: client.shortId,
      masterSocketId: socket.id,
      timestamp: new Date().toISOString(),
      isRecovery: isRecovery
    });
    
    console.log(`[${new Date().toISOString()}] Client ${client.shortId} is now master ${isRecovery ? '(recovered)' : ''}`);
    
    // Process any pending master requests
    if (masterRequestQueue.length > 0) {
      console.log(`Processing ${masterRequestQueue.length} pending requests`);
      masterRequestQueue.forEach(request => {
        socket.emit('tts-request', request);
      });
      masterRequestQueue = [];
    }
  });
  
  // Handle release master role
  socket.on('release-master-role', (data) => {
    if (socket.id === masterClient) {
      const oldMaster = connectedClients.get(masterClient);
      masterClient = null;
      connectedClients.get(socket.id).isMaster = false;
      
      io.emit('master-released', {
        oldMasterId: oldMaster?.id,
        oldMasterShortId: oldMaster?.shortId,
        timestamp: new Date().toISOString(),
        message: 'Master controller telah melepaskan peran',
        wasIntentional: data.isIntentional || false
      });
      
      socket.emit('master-role-released', {
        isMaster: false,
        message: 'Anda telah melepaskan peran master',
        isIntentional: data.isIntentional || false
      });
      
      console.log(`[${new Date().toISOString()}] Client ${oldMaster?.shortId} released master role ${data.isIntentional ? '(intentional)' : ''}`);
      
      // If intentional release, don't keep in recovery queue
      if (data.isIntentional) {
        masterHistory.delete(oldMaster?.id);
      } else {
        // If not intentional, keep for recovery
        updateMasterHistoryOnDisconnect(oldMaster?.id);
      }
    }
  });
  
  // Handle TTS request from clients
  socket.on('tts-request', async (data) => {
    const client = connectedClients.get(socket.id);
    const { text, language = 'id-ID', speed = 1.0, priority = 'normal' } = data;
    
    console.log(`[${new Date().toISOString()}] TTS Request from ${client?.shortId}: ${language}, Text Length: ${text?.length || 0}`);
    
    try {
      // Validasi input dengan detail
      if (!text || typeof text !== 'string') {
        socket.emit('tts-error', {
          success: false,
          error: 'Teks harus berupa string'
        });
        return;
      }
      
      const trimmedText = text.trim();
      if (trimmedText.length === 0) {
        socket.emit('tts-error', {
          success: false,
          error: 'Teks tidak boleh kosong atau hanya spasi'
        });
        return;
      }
      
      if (text.length > 5000) {
        socket.emit('tts-error', {
          success: false,
          error: `Teks terlalu panjang (${text.length} karakter). Maksimal 5000 karakter.`,
          suggestion: 'Coba bagi teks menjadi beberapa bagian'
        });
        return;
      }
      
      // If no master, queue the request
      if (!masterClient) {
        masterRequestQueue.push({
          ...data,
          text: trimmedText,
          fromClientId: client.id,
          fromClientShortId: client.shortId,
          timestamp: new Date().toISOString(),
          priority: priority
        });
        
        socket.emit('tts-queued', {
          success: true,
          message: 'TTS request dalam antrian. Menunggu master controller...',
          queuePosition: masterRequestQueue.length,
          textLength: text.length
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
        speed: Math.max(0.5, Math.min(parseFloat(speed) || 1.0, 2.0))
      });
      
      // Send audio to MASTER CLIENT only
      io.to(masterClient).emit('tts-audio', {
        ...result,
        fromClientId: client.id,
        fromClientShortId: client.shortId,
        fromClientSocketId: socket.id,
        timestamp: new Date().toISOString(),
        priority: priority,
        requestId: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      });
      
      // Send confirmation to sender
      socket.emit('tts-complete', {
        success: true,
        message: 'Audio telah dikirim ke Master Controller',
        masterClientId: connectedClients.get(masterClient)?.id,
        masterShortId: connectedClients.get(masterClient)?.shortId,
        textLength: text.length,
        language: language,
        duration: result.duration
      });
      
      // Notify all clients about new TTS (except sender and master)
      socket.broadcast.emit('tts-notification', {
        fromClientId: client.id,
        fromClientShortId: client.shortId,
        textPreview: text.length > 50 ? text.substring(0, 50) + '...' : text,
        language: language,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`[${new Date().toISOString()}] TTS Error for ${client?.shortId}:`, error.message);
      
      // Error message yang lebih user-friendly
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
      
      socket.emit('tts-error', {
        success: false,
        error: `${userMessage} (Detail: ${error.message})`,
        suggestion: suggestion
      });
    }
  });
  
  // Handle broadcast TTS (to all clients)
  socket.on('tts-broadcast', async (data) => {
    const client = connectedClients.get(socket.id);
    
    // Only master can broadcast
    if (socket.id !== masterClient) {
      socket.emit('broadcast-denied', {
        success: false,
        error: 'Hanya Master Controller yang dapat melakukan broadcast'
      });
      return;
    }
    
    const { text, language = 'id-ID', speed = 1.0 } = data;
    
    try {
      const result = await googleTTSService.convertTextToSpeech({
        text: text,
        language: language,
        speed: speed
      });
      
      // Send audio to ALL clients
      io.emit('tts-audio-broadcast', {
        ...result,
        fromClientId: client.id,
        fromClientShortId: client.shortId,
        broadcast: true,
        timestamp: new Date().toISOString()
      });
      
      console.log(`[${new Date().toISOString()}] Broadcast TTS from ${client.shortId} to all clients`);
      
    } catch (error) {
      console.error('Broadcast TTS Error:', error.message);
      socket.emit('tts-error', {
        success: false,
        error: 'Gagal melakukan broadcast TTS'
      });
    }
  });
  
  // Handle master-only audio playback (audio hanya di master)
  socket.on('play-audio-master-only', (audioData) => {
    if (socket.id === masterClient) {
      // Kirim audio hanya ke master itu sendiri
      socket.emit('play-audio-master', {
        ...audioData,
        issuedBy: connectedClients.get(socket.id)?.id,
        issuedByShortId: connectedClients.get(socket.id)?.shortId,
        timestamp: new Date().toISOString(),
        isMasterOnly: true
      });
      
      console.log(`[${new Date().toISOString()}] Master ${connectedClients.get(socket.id)?.shortId} playing audio locally only`);
    } else {
      socket.emit('play-audio-denied', {
        reason: 'Hanya Master Controller yang dapat memutar audio'
      });
    }
  });
  
  // Handle broadcast audio (ke semua client)
  socket.on('play-audio-broadcast', (audioData) => {
    if (socket.id === masterClient) {
      io.emit('play-audio-command', {
        ...audioData,
        issuedBy: connectedClients.get(socket.id)?.id,
        issuedByShortId: connectedClients.get(socket.id)?.shortId,
        timestamp: new Date().toISOString(),
        isBroadcast: true
      });
    }
  });
  
  // Handle client requesting to stop audio
  socket.on('stop-audio', () => {
    if (socket.id === masterClient) {
      io.emit('stop-audio-command', {
        issuedBy: connectedClients.get(socket.id)?.id,
        issuedByShortId: connectedClients.get(socket.id)?.shortId,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // Handle audio playback status
  socket.on('audio-status', (status) => {
    const client = connectedClients.get(socket.id);
    io.emit('client-audio-status', {
      clientId: client.id,
      clientShortId: client.shortId,
      status: status,
      timestamp: new Date().toISOString()
    });
  });
  
  // Handle ping from client
  socket.on('ping', (data) => {
    const client = connectedClients.get(socket.id);
    if (client) {
      client.lastActivity = new Date();
      
      // Update master status if this is a master
      if (client.isMaster) {
        const history = masterHistory.get(client.id);
        if (history) {
          history.lastActivity = new Date();
        }
      }
    }
    socket.emit('pong', {
      serverTime: new Date().toISOString(),
      clientId: client?.id,
      clientShortId: client?.shortId,
      isMaster: client?.isMaster || false
    });
  });
  
  // Handle disconnect
  socket.on('disconnect', (reason) => {
    const client = connectedClients.get(socket.id);
    console.log(`[${new Date().toISOString()}] Client disconnected: ${client?.shortId || socket.id} - Reason: ${reason}`);
    
    // If master disconnects, clear master role
    if (socket.id === masterClient) {
      const disconnectedMaster = client;
      masterClient = null;
      
      // Update master history
      if (disconnectedMaster) {
        updateMasterHistoryOnDisconnect(disconnectedMaster.id);
        
        const history = masterHistory.get(disconnectedMaster.id);
        if (history) {
          history.lastDisconnect = new Date();
          history.disconnectReason = reason;
        }
      }
      
      io.emit('master-disconnected', {
        disconnectedMasterId: disconnectedMaster?.id,
        disconnectedMasterShortId: disconnectedMaster?.shortId,
        timestamp: new Date().toISOString(),
        message: 'Master Controller terputus. Sistem akan mencoba recovery otomatis.',
        disconnectReason: reason,
        canRecover: true // Tandai bahwa recovery dimungkinkan
      });
      
      // Clear master queue
      if (masterRequestQueue.length > 0) {
        masterRequestQueue.forEach(request => {
          io.emit('tts-request-cancelled', {
            request: request,
            reason: 'Master Controller terputus'
          });
        });
        masterRequestQueue = [];
      }
      
      // Check if any previous masters are connected
      const previousMasters = Array.from(connectedClients.values()).filter(client => 
        isPreviousMaster(client.id) && client.socketId !== socket.id
      );
      
      if (previousMasters.length > 0) {
        // Notify previous masters that recovery is available
        previousMasters.forEach(prevMaster => {
          io.to(prevMaster.socketId).emit('master-recovery-available', {
            message: 'Master terputus. Anda dapat mengambil alih sebagai Master.',
            previousMaster: true,
            disconnectedMasterShortId: disconnectedMaster?.shortId
          });
        });
      }
    }
    
    // Remove from connected clients
    connectedClients.delete(socket.id);
    
    // Notify remaining clients
    io.emit('client-disconnected', {
      clientId: client?.id,
      clientShortId: client?.shortId,
      totalClients: connectedClients.size,
      reason: reason,
      connectedClients: Array.from(connectedClients.values()).map(c => ({
        id: c.id,
        shortId: c.shortId,
        isMaster: c.isMaster
      }))
    });
  });
  
  // Handle errors
  socket.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] Socket error for ${clientId}:`, error);
  });
});

// Clean up inactive clients periodically
setInterval(() => {
  const now = new Date();
  const inactiveThreshold = 5 * 60 * 1000; // 5 minutes
  
  connectedClients.forEach((client, socketId) => {
    if (now - client.lastActivity > inactiveThreshold) {
      console.log(`[${new Date().toISOString()}] Removing inactive client: ${client.shortId}`);
      
      if (socketId === masterClient) {
        const disconnectedMaster = client;
        masterClient = null;
        
        // Update master history
        if (disconnectedMaster) {
          updateMasterHistoryOnDisconnect(disconnectedMaster.id);
        }
        
        io.emit('master-inactive', {
          inactiveClientId: disconnectedMaster?.id,
          inactiveClientShortId: disconnectedMaster?.shortId,
          timestamp: now.toISOString(),
          reason: 'inactivity'
        });
      }
      
      connectedClients.delete(socketId);
      io.to(socketId).disconnect(true);
    }
  });
}, 60 * 1000); // Check every minute

// Clean old master history periodically
setInterval(() => {
  cleanOldMasterHistory();
}, 30 * 60 * 1000); // Every 30 minutes

// API Routes - Semua menjadi public
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Multi-Client TTS Server v2.0 with Master Recovery',
    serverUptime: process.uptime(),
    connectedClients: connectedClients.size,
    masterClient: masterClient ? connectedClients.get(masterClient)?.shortId : null,
    pendingRequests: masterRequestQueue.length,
    masterHistoryCount: masterHistory.size,
    memoryUsage: process.memoryUsage()
  });
});

app.get('/api/clients', (req, res) => {
  const clients = Array.from(connectedClients.values()).map(client => ({
    id: client.id,
    shortId: client.shortId,
    isMaster: client.isMaster,
    joinedAt: client.joinedAt,
    lastActivity: client.lastActivity,
    clientInfo: client.clientInfo,
    isReturningMaster: client.isReturningMaster
  }));
  
  res.json({
    success: true,
    totalClients: connectedClients.size,
    masterClient: masterClient ? connectedClients.get(masterClient)?.id : null,
    masterShortId: masterClient ? connectedClients.get(masterClient)?.shortId : null,
    masterSocketId: masterClient,
    pendingRequests: masterRequestQueue.length,
    masterHistory: Array.from(masterHistory.entries()).map(([id, data]) => ({
      id: id,
      shortId: data.shortId,
      firstBecameMaster: data.firstBecameMaster,
      lastBecameMaster: data.lastBecameMaster,
      timesMaster: data.timesMaster,
      recoveryAttempts: data.recoveryAttempts || 0
    })),
    clients: clients
  });
});

app.post('/api/set-master', (req, res) => {
  const { clientId, forceRecovery = false } = req.body;
  
  if (!clientId) {
    return res.status(400).json({
      success: false,
      error: 'clientId diperlukan'
    });
  }
  
  // Find client by ID
  let targetSocketId = null;
  connectedClients.forEach((client, socketId) => {
    if (client.id === clientId || client.shortId === clientId) {
      targetSocketId = socketId;
    }
  });
  
  if (!targetSocketId) {
    return res.status(404).json({
      success: false,
      error: 'Client tidak ditemukan'
    });
  }
  
  // Check if master already exists
  if (masterClient && masterClient !== targetSocketId && !forceRecovery) {
    const currentMaster = connectedClients.get(masterClient);
    return res.status(400).json({
      success: false,
      error: 'Master sudah ada',
      currentMaster: currentMaster?.shortId
    });
  }
  
  // Set as master
  const oldMaster = masterClient;
  masterClient = targetSocketId;
  
  // Update client status
  connectedClients.forEach((client, socketId) => {
    client.isMaster = (socketId === targetSocketId);
  });
  
  const newMaster = connectedClients.get(targetSocketId);
  
  // Add to master history
  addToMasterHistory(newMaster.id, newMaster.shortId);
  
  // Notify all clients
  io.emit('master-changed', {
    masterClientId: newMaster.id,
    masterShortId: newMaster.shortId,
    masterSocketId: targetSocketId,
    oldMasterId: oldMaster ? connectedClients.get(oldMaster)?.id : null,
    oldMasterShortId: oldMaster ? connectedClients.get(oldMaster)?.shortId : null,
    timestamp: new Date().toISOString(),
    changedBy: 'api'
  });
  
  res.json({
    success: true,
    message: `Client ${newMaster.shortId} sekarang menjadi Master Controller`,
    masterClient: newMaster.shortId,
    wasRecovery: !!oldMaster
  });
});

app.post('/api/clear-queue', (req, res) => {
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
    res.status(500).json({
      success: false,
      error: 'Gagal mengambil daftar bahasa'
    });
  }
});

app.post('/api/tts', async (req, res) => {
    try {
        const { text, language = 'id-ID', speed = 1.0, broadcast = false } = req.body;
        
        console.log(`API TTS Request - Text length: ${text?.length || 0}, Language: ${language}`);
        
        // Validasi lebih detail
        if (!text || typeof text !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Text harus berupa string'
            });
        }
        
        if (text.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Text tidak boleh kosong atau hanya spasi'
            });
        }
        
        if (text.length > 5000) {
            return res.status(400).json({
                success: false,
                error: `Text terlalu panjang (${text.length} karakter). Maksimal 5000 karakter.`
            });
        }
        
        const validSpeed = Math.max(0.5, Math.min(parseFloat(speed) || 1.0, 2.0));
        
        console.log(`[${new Date().toISOString()}] API TTS Request: ${language}, Speed: ${validSpeed}, Text Length: ${text.length}`);
        
        const result = await googleTTSService.convertTextToSpeech({
            text: text,
            language: language,
            speed: validSpeed
        });
        
        if (broadcast && masterClient) {
            io.emit('tts-audio-broadcast', {
                ...result,
                fromClientId: 'api-request',
                fromClientShortId: 'api',
                broadcast: true,
                timestamp: new Date().toISOString()
            });
        } else if (masterClient) {
            io.to(masterClient).emit('tts-audio', {
                ...result,
                fromClientId: 'api-request',
                fromClientShortId: 'api',
                timestamp: new Date().toISOString(),
                priority: 'high'
            });
        }
        
        res.json({
            ...result,
            broadcasted: broadcast,
            masterClient: masterClient ? connectedClients.get(masterClient)?.shortId : null,
            clientCount: connectedClients.size
        });
        
    } catch (error) {
        console.error('API TTS Error:', error.message);
        
        // Error yang lebih spesifik
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
        
        res.status(500).json({
            success: false,
            error: errorMessage,
            suggestion: suggestion
        });
    }
});

app.get('/api/test', async (req, res) => {
  try {
    const testResult = await googleTTSService.testConnection();
    res.json(testResult);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/stats', (req, res) => {
  const stats = {
    connectedClients: connectedClients.size,
    masterClient: masterClient ? connectedClients.get(masterClient)?.shortId : null,
    pendingRequests: masterRequestQueue.length,
    masterHistoryCount: masterHistory.size,
    serverUptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    activeSince: new Date(Date.now() - process.uptime() * 1000).toISOString()
  };
  
  res.json({
    success: true,
    stats: stats
  });
});

app.get('/api/master-status', (req, res) => {
  const currentMaster = masterClient ? connectedClients.get(masterClient) : null;
  const masterHistoryArray = Array.from(masterHistory.entries()).map(([id, data]) => ({
    clientId: id,
    shortId: data.shortId,
    firstBecameMaster: data.firstBecameMaster,
    lastBecameMaster: data.lastBecameMaster,
    timesMaster: data.timesMaster,
    recoveryAttempts: data.recoveryAttempts || 0,
    lastDisconnect: data.lastDisconnect
  }));
  
  const previousMastersConnected = Array.from(connectedClients.values())
    .filter(client => isPreviousMaster(client.id) && client.socketId !== masterClient)
    .map(client => ({
      id: client.id,
      shortId: client.shortId,
      connectedSince: client.joinedAt
    }));
  
  res.json({
    success: true,
    currentMaster: currentMaster ? {
      id: currentMaster.id,
      shortId: currentMaster.shortId,
      socketId: currentMaster.socketId,
      isConnected: true,
      connectedSince: currentMaster.joinedAt
    } : null,
    masterHistory: masterHistoryArray,
    previousMastersConnected: previousMastersConnected,
    canRecover: !currentMaster && previousMastersConnected.length > 0,
    pendingRecovery: masterRequestQueue.length
  });
});

app.post('/api/force-master-recovery', (req, res) => {
  const { clientId } = req.body;
  
  if (!clientId) {
    return res.status(400).json({
      success: false,
      error: 'clientId diperlukan'
    });
  }
  
  // Find client by ID
  let targetSocketId = null;
  connectedClients.forEach((client, socketId) => {
    if (client.id === clientId || client.shortId === clientId) {
      targetSocketId = socketId;
    }
  });
  
  if (!targetSocketId) {
    return res.status(404).json({
      success: false,
      error: 'Client tidak ditemukan'
    });
  }
  
  // Force recovery even if there's already a master
  const oldMaster = masterClient;
  masterClient = targetSocketId;
  
  // Update client status
  connectedClients.forEach((client, socketId) => {
    client.isMaster = (socketId === targetSocketId);
  });
  
  const newMaster = connectedClients.get(targetSocketId);
  
  // Add to master history
  addToMasterHistory(newMaster.id, newMaster.shortId);
  
  // Notify all clients about forced recovery
  io.emit('master-changed', {
    masterClientId: newMaster.id,
    masterShortId: newMaster.shortId,
    masterSocketId: targetSocketId,
    oldMasterId: oldMaster ? connectedClients.get(oldMaster)?.id : null,
    oldMasterShortId: oldMaster ? connectedClients.get(oldMaster)?.shortId : null,
    timestamp: new Date().toISOString(),
    changedBy: 'api-force-recovery',
    wasForced: true
  });
  
  // Notify the new master
  io.to(targetSocketId).emit('master-recovery-success', {
    message: 'Status Master berhasil dipulihkan secara paksa',
    wasForced: true,
    previousMaster: oldMaster ? connectedClients.get(oldMaster)?.shortId : null
  });
  
  res.json({
    success: true,
    message: `Client ${newMaster.shortId} berhasil dipaksa menjadi Master Controller`,
    masterClient: newMaster.shortId,
    wasForced: true,
    previousMaster: oldMaster ? connectedClients.get(oldMaster)?.shortId : null
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Server Error:`, err.stack);
  res.status(500).json({
    success: false,
    error: 'Terjadi kesalahan internal server',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint tidak ditemukan'
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const serverUrl = `http://${process.env.SERVER_IP || 'localhost'}:${PORT}`;
  console.log(`\n🚀 ========================================`);
  console.log(`   Multi-Client TTS Server v2.0 with Master Recovery`);
  console.log(`   Berjalan di: ${serverUrl}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Socket.IO aktif`);
  console.log(`   Tanggal: ${new Date().toLocaleString()}`);
  console.log(`========================================\n`);
  console.log(`📡 Socket.IO siap menerima koneksi`);
  console.log(`\n📚 API Endpoints:`);
  console.log(`   GET  ${serverUrl}/api/health      - Cek status server & client`);
  console.log(`   GET  ${serverUrl}/api/clients     - Daftar client terhubung`);
  console.log(`   GET  ${serverUrl}/api/stats       - Statistik server`);
  console.log(`   GET  ${serverUrl}/api/master-status - Status recovery master`);
  console.log(`   POST ${serverUrl}/api/set-master  - Atur client sebagai master`);
  console.log(`   POST ${serverUrl}/api/force-master-recovery - Paksa recovery master`);
  console.log(`   POST ${serverUrl}/api/tts         - Konversi teks ke suara`);
  console.log(`   GET  ${serverUrl}/api/languages   - Daftar bahasa yang didukung`);
  console.log(`   POST ${serverUrl}/api/clear-queue - Hapus antrian TTS`);
  console.log(`\n🌐 Frontend tersedia di: ${serverUrl}`);
  console.log(`\n🔧 Fitur Master Recovery:`);
  console.log(`   - Master yang terputus otomatis mencoba kembali`);
  console.log(`   - Penyimpanan status di localStorage`);
  console.log(`   - Priority recovery untuk master sebelumnya`);
  console.log(`   - Auto-reconnect lebih agresif untuk master`);
  console.log(`\n========================================\n`);
});
