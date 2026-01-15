require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const googleTTSService = require('./services/googleTTSService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT) || 5000,
  pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL) || 25000,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(morgan(process.env.LOG_LEVEL || 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// Store connected clients and their info
const connectedClients = new Map();
let masterClients = new Set(); // Multiple masters
let masterRequestQueue = [];

// Track previous masters for reconnection
const previousMasters = new Map(); // clientId -> { wantsToBeMaster: true, lastSeen: Date }

// Generate unique client ID
const generateClientId = () => {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  const clientId = generateClientId();
  console.log(`[${new Date().toISOString()}] Client connected: ${clientId} (Socket: ${socket.id})`);
  
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
    connectedClients: Array.from(connectedClients.values()).map(client => ({
      id: client.id,
      isMaster: client.isMaster,
      joinedAt: client.joinedAt,
      wantsToBeMaster: client.wantsToBeMaster
    }))
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
      masterList: Array.from(masterClients).map(sid => ({
        id: connectedClients.get(sid)?.id,
        socketId: sid
      })),
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
      }
      
      // Store if client wants to be master
      if (info.wantsToBeMaster !== undefined) {
        client.wantsToBeMaster = info.wantsToBeMaster;
        console.log(`Client ${client.id} wantsToBeMaster: ${info.wantsToBeMaster}`);
        
        // Track this preference for future reconnections
        previousMasters.set(client.id, {
          wantsToBeMaster: info.wantsToBeMaster,
          wasMaster: info.wasMaster || false,
          lastSeen: new Date()
        });
      }
      
      // Check if reconnecting client wants to be master and was master
      if (info.reconnected && info.wantsToBeMaster) {
        console.log(`Reconnecting client ${client.id} wants master. Was master: ${info.wasMaster}`);
        
        if (info.wasMaster) {
          // This client was a master before disconnection
          console.log(`Client ${client.id} was previously a master, restoring role...`);
          
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
                masterList: Array.from(masterClients).map(sid => ({
                  id: connectedClients.get(sid)?.id,
                  socketId: sid
                })),
                reason: 'auto-reconnect-was-master'
              });
              
              console.log(`[${new Date().toISOString()}] Restored master role to ${client.id} in multi-master mode`);
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
                masterList: Array.from(masterClients).map(sid => ({
                  id: connectedClients.get(sid)?.id,
                  socketId: sid
                })),
                reason: 'auto-reconnect-no-masters'
              });
              
              console.log(`[${new Date().toISOString()}] Restored master role to ${client.id} (first master)`);
            }
          }
        } else if (masterClients.size === 0) {
          // Client wants to be master and no masters available
          console.log(`Granting master to ${client.id} (no masters available)`);
          
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
            masterList: Array.from(masterClients).map(sid => ({
              id: connectedClients.get(sid)?.id,
              socketId: sid
            })),
            reason: 'auto-reconnect-requested'
          });
        }
      }
    }
  });
  
  // Handle request to become master
  socket.on('request-master-role', (data) => {
    const client = connectedClients.get(socket.id);
    console.log(`[${new Date().toISOString()}] Master role requested by: ${client?.id}`);
    
    // Update client preference
    if (client) {
      client.wantsToBeMaster = data.wantsToBeMaster || false;
      
      // Track preference for reconnection
      previousMasters.set(client.id, {
        wantsToBeMaster: data.wantsToBeMaster || false,
        wasMaster: true,
        lastSeen: new Date()
      });
    }
    
    // Add to masters if not already a master
    if (!masterClients.has(socket.id)) {
      masterClients.add(socket.id);
      connectedClients.get(socket.id).isMaster = true;
      connectedClients.get(socket.id).wantsToBeMaster = true;
      
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
        masterList: Array.from(masterClients).map(sid => ({
          id: connectedClients.get(sid)?.id,
          socketId: sid
        })),
        reason: 'manual-request'
      });
      
      console.log(`[${new Date().toISOString()}] Client ${client.id} added to masters. Total: ${masterClients.size}`);
      
      // Process any pending master requests
      if (masterRequestQueue.length > 0) {
        console.log(`Processing ${masterRequestQueue.length} pending requests for ${masterClients.size} masters`);
        masterRequestQueue.forEach(request => {
          // Send to all masters
          masterClients.forEach(masterSocketId => {
            io.to(masterSocketId).emit('tts-request', request);
          });
        });
        masterRequestQueue = [];
      }
    } else {
      // Already a master
      socket.emit('master-role-duplicate', {
        message: 'Anda sudah menjadi Master Controller',
        totalMasters: masterClients.size
      });
    }
  });
  
  // Handle release master role
  socket.on('release-master-role', (data) => {
    const client = connectedClients.get(socket.id);
    
    if (masterClients.has(socket.id)) {
      // Remove from masters
      masterClients.delete(socket.id);
      client.isMaster = false;
      
      // Update preference if specified
      if (data && data.clearPreference) {
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
        masterList: Array.from(masterClients).map(sid => ({
          id: connectedClients.get(sid)?.id,
          socketId: sid
        }))
      });
      
      socket.emit('master-role-released', {
        isMaster: false,
        message: 'Anda telah melepaskan peran master',
        totalMasters: masterClients.size,
        preferenceCleared: data ? data.clearPreference : false
      });
      
      console.log(`[${new Date().toISOString()}] Client ${client.id} removed from masters. Total: ${masterClients.size}`);
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
  socket.on('tts-request', async (data) => {
    const client = connectedClients.get(socket.id);
    const { text, language = 'id-ID', speed = 1.0, priority = 'normal' } = data;
    
    console.log(`[${new Date().toISOString()}] TTS Request from ${client?.id} to all masters: ${language}, Text Length: ${text?.length || 0}`);
    
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
      
      // If no masters, queue the request
      if (masterClients.size === 0) {
        masterRequestQueue.push({
          ...data,
          text: trimmedText,
          fromClientId: client.id,
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
      
      // Kirim ke semua master
      masterClients.forEach(masterSocketId => {
        io.to(masterSocketId).emit('tts-audio', {
          ...result,
          fromClientId: client.id,
          fromClientSocketId: socket.id,
          timestamp: new Date().toISOString(),
          priority: priority,
          requestId: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          forMasterOnly: true,
          masterCount: masterClients.size
        });
      });
      
      socket.emit('tts-complete', {
        success: true,
        message: `Audio telah dikirim ke ${masterClients.size} Master Controller`,
        masterCount: masterClients.size,
        textLength: text.length,
        language: language,
        duration: result.duration
      });
      
      // Notify all clients about new TTS (except sender)
      socket.broadcast.emit('tts-notification', {
        fromClientId: client.id,
        textPreview: text.length > 50 ? text.substring(0, 50) + '...' : text,
        language: language,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`[${new Date().toISOString()}] TTS Error for ${client?.id}:`, error.message);
      
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
  
  // Handle client requesting to play audio (master only)
  socket.on('play-audio', (audioData) => {
    if (masterClients.has(socket.id)) {
      socket.emit('play-audio-denied', {
        reason: 'Fitur broadcast audio tidak tersedia'
      });
    } else {
      socket.emit('play-audio-denied', {
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
  socket.on('audio-status', (status) => {
    const client = connectedClients.get(socket.id);
    io.emit('client-audio-status', {
      clientId: client.id,
      status: status,
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
    console.log(`[${new Date().toISOString()}] Client disconnected: ${client?.id || socket.id} - Reason: ${reason}`);
    
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
      
      io.emit('master-disconnected', {
        disconnectedMasterId: client?.id,
        wantsToBeMaster: client?.wantsToBeMaster || false,
        wasMaster: wasMaster,
        timestamp: new Date().toISOString(),
        totalMasters: masterClients.size,
        masterList: Array.from(masterClients).map(sid => ({
          id: connectedClients.get(sid)?.id,
          socketId: sid
        })),
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
    console.error(`[${new Date().toISOString()}] Socket error for ${clientId}:`, error);
  });
});

// Clean up inactive clients periodically
setInterval(() => {
  const now = new Date();
  const inactiveThreshold = 5 * 60 * 1000; // 5 minutes
  
  connectedClients.forEach((client, socketId) => {
    if (now - client.lastActivity > inactiveThreshold) {
      console.log(`[${new Date().toISOString()}] Removing inactive client: ${client.id}`);
      
      if (masterClients.has(socketId)) {
        masterClients.delete(socketId);
        io.emit('master-inactive', {
          inactiveClientId: client.id,
          timestamp: now.toISOString(),
          totalMasters: masterClients.size
        });
      }
      
      connectedClients.delete(socketId);
      io.to(socketId).disconnect(true);
    }
  });
}, 60 * 1000); // Check every minute

// API Routes
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
  const clients = Array.from(connectedClients.values()).map(client => ({
    id: client.id,
    isMaster: client.isMaster,
    joinedAt: client.joinedAt,
    lastActivity: client.lastActivity,
    clientInfo: client.clientInfo,
    wantsToBeMaster: client.wantsToBeMaster
  }));
  
  res.json({
    success: true,
    totalClients: connectedClients.size,
    totalMasters: masterClients.size,
    pendingRequests: masterRequestQueue.length,
    clients: clients
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

app.post('/api/add-master', (req, res) => {
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
    if (client.id === clientId) {
      targetSocketId = socketId;
    }
  });
  
  if (!targetSocketId) {
    return res.status(404).json({
      success: false,
      error: 'Client tidak ditemukan'
    });
  }
  
  // Add to masters if not already a master
  if (!masterClients.has(targetSocketId)) {
    masterClients.add(targetSocketId);
    connectedClients.get(targetSocketId).isMaster = true;
    connectedClients.get(targetSocketId).wantsToBeMaster = true;
    
    // Track for reconnection
    previousMasters.set(clientId, {
      wantsToBeMaster: true,
      wasMaster: true,
      lastSeen: new Date()
    });
    
    // Notify client
    io.to(targetSocketId).emit('master-role-granted', {
      isMaster: true,
      clientId: clientId,
      message: 'Anda ditambahkan sebagai Master Controller oleh admin',
      totalMasters: masterClients.size
    });
    
    // Notify all
    io.emit('master-added', {
      masterClientId: clientId,
      masterSocketId: targetSocketId,
      timestamp: new Date().toISOString(),
      totalMasters: masterClients.size,
      masterList: Array.from(masterClients).map(sid => ({
        id: connectedClients.get(sid)?.id,
        socketId: sid
      })),
      addedBy: 'api'
    });
    
    res.json({
      success: true,
      message: `Client ${clientId} ditambahkan sebagai Master Controller`,
      totalMasters: masterClients.size
    });
  } else {
    res.json({
      success: false,
      message: `Client ${clientId} sudah menjadi Master Controller`
    });
  }
});

app.post('/api/remove-master', (req, res) => {
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
    if (client.id === clientId) {
      targetSocketId = socketId;
    }
  });
  
  if (!targetSocketId) {
    return res.status(404).json({
      success: false,
      error: 'Client tidak ditemukan'
    });
  }
  
  // Remove from masters if exists
  if (masterClients.has(targetSocketId)) {
    masterClients.delete(targetSocketId);
    connectedClients.get(targetSocketId).isMaster = false;
    
    // Update previous masters tracking
    previousMasters.set(clientId, {
      wantsToBeMaster: false,
      wasMaster: false,
      lastSeen: new Date()
    });
    
    // Notify client
    io.to(targetSocketId).emit('master-role-removed', {
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
      masterList: Array.from(masterClients).map(sid => ({
        id: connectedClients.get(sid)?.id,
        socketId: sid
      })),
      removedBy: 'api'
    });
    
    res.json({
      success: true,
      message: `Client ${clientId} dikeluarkan dari Master Controller`,
      totalMasters: masterClients.size
    });
  } else {
    res.json({
      success: false,
      message: `Client ${clientId} bukan Master Controller`
    });
  }
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
    const { text, language = 'id-ID', speed = 1.0 } = req.body;
    
    console.log(`API TTS Request - Text length: ${text?.length || 0}, Language: ${language}`);
    
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
    
    // Kirim ke semua master jika ada
    if (masterClients.size > 0) {
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
    } else {
      res.json({
        success: false,
        error: 'Tidak ada Master Controller yang terhubung',
        result: result,
        clientCount: connectedClients.size
      });
    }
    
  } catch (error) {
    console.error('API TTS Error:', error.message);
    
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
  
  let isMaster = false;
  let socketId = null;
  let exists = false;
  
  // Cari client berdasarkan ID
  connectedClients.forEach((client, sid) => {
    if (client.id === clientId) {
      socketId = sid;
      isMaster = masterClients.has(sid);
      exists = true;
    }
  });
  
  res.json({
    success: true,
    clientId: clientId,
    isMaster: isMaster,
    socketId: socketId,
    exists: exists,
    totalMasters: masterClients.size,
    previousMasterData: previousMasters.get(clientId) || null
  });
});

app.get('/api/master-preference/:clientId', (req, res) => {
  const { clientId } = req.params;
  
  let targetSocketId = null;
  connectedClients.forEach((client, socketId) => {
    if (client.id === clientId) {
      targetSocketId = socketId;
    }
  });
  
  if (targetSocketId) {
    const client = connectedClients.get(targetSocketId);
    res.json({
      success: true,
      clientId: clientId,
      wantsToBeMaster: client.wantsToBeMaster || false,
      isMaster: client.isMaster || false,
      previousMasterData: previousMasters.get(clientId) || null
    });
  } else {
    res.json({
      success: false,
      error: 'Client tidak ditemukan',
      clientId: clientId
    });
  }
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
  console.log(`   Multi-Master TTS Server v3.0`);
  console.log(`   Berjalan di: ${serverUrl}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Socket.IO aktif`);
  console.log(`   Tanggal: ${new Date().toLocaleString()}`);
  console.log(`========================================\n`);
  console.log(`📡 Socket.IO siap menerima koneksi`);
  console.log(`\n📚 API Endpoints:`);
  console.log(`   GET  ${serverUrl}/api/health      - Cek status server & client`);
  console.log(`   GET  ${serverUrl}/api/clients     - Daftar client terhubung`);
  console.log(`   GET  ${serverUrl}/api/masters     - Daftar master aktif`);
  console.log(`   GET  ${serverUrl}/api/stats       - Statistik server`);
  console.log(`   POST ${serverUrl}/api/add-master  - Tambah client sebagai master`);
  console.log(`   POST ${serverUrl}/api/tts         - Konversi teks ke suara`);
  console.log(`   GET  ${serverUrl}/api/languages   - Daftar bahasa yang didukung`);
  console.log(`   POST ${serverUrl}/api/clear-queue - Hapus antrian TTS`);
  console.log(`   GET  ${serverUrl}/api/client-status/:clientId - Cek status client`);
  console.log(`\n🌐 Frontend tersedia di: ${serverUrl}`);
  console.log(`\n🔧 Fitur: Multi-Master TTS`);
  console.log(`   • Multiple master dapat aktif bersamaan`);
  console.log(`   • Client selalu kirim ke semua master`);
  console.log(`   • Tidak ada broadcast atau spesifik master`);
  console.log(`   • Master preference disimpan di localStorage`);
  console.log(`   • Auto-reconnect saat browser di-refresh`);
  console.log(`   • Master tetap stabil setelah refresh`);
  console.log(`\n========================================\n`);
});