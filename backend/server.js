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
let masterClient = null;
let masterRequestQueue = [];

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
    reconnected: false
  });
  
  // Send welcome message with client ID
  socket.emit('welcome', {
    clientId: clientId,
    serverTime: new Date().toISOString(),
    message: 'Terhubung ke TTS Multi-Client Server',
    totalClients: connectedClients.size
  });
  
  // Send current connection status
  socket.emit('connection-status', {
    clientId: clientId,
    isMaster: masterClient === socket.id,
    totalClients: connectedClients.size,
    masterClient: masterClient ? connectedClients.get(masterClient)?.id : null,
    connectedClients: Array.from(connectedClients.values()).map(client => ({
      id: client.id,
      isMaster: client.isMaster,
      joinedAt: client.joinedAt
    }))
  });
  
  // Notify other clients about new connection
  socket.broadcast.emit('client-connected', {
    clientId: clientId,
    totalClients: connectedClients.size,
    connectedClients: Array.from(connectedClients.values()).map(client => ({
      id: client.id,
      isMaster: client.isMaster
    }))
  });
  
  // Handle client info update with master preference
  socket.on('client-info', (info) => {
    const client = connectedClients.get(socket.id);
    if (client) {
      client.clientInfo = { ...client.clientInfo, ...info };
      client.lastActivity = new Date();
      
      // Store if client wants to be master
      if (info.wantsToBeMaster !== undefined) {
        client.wantsToBeMaster = info.wantsToBeMaster;
        console.log(`Client ${client.id} wantsToBeMaster: ${info.wantsToBeMaster}`);
      }
      
      // Check if reconnecting client wants to be master
      if (info.reconnected && info.wantsToBeMaster && !masterClient) {
        console.log(`Auto-granting master to reconnecting client: ${client.id}`);
        // Auto-grant master to reconnecting client who wants it
        masterClient = socket.id;
        client.isMaster = true;
        
        socket.emit('master-role-granted', { 
          isMaster: true,
          clientId: client.id,
          message: 'Anda kembali sebagai Master Controller',
          autoReconnected: true
        });
        
        io.emit('master-changed', { 
          masterClientId: client.id,
          masterSocketId: socket.id,
          timestamp: new Date().toISOString(),
          reason: 'auto-reconnect'
        });
      }
    }
  });
  
  // Handle request to become master
  socket.on('request-master-role', (data) => {
    const client = connectedClients.get(socket.id);
    console.log(`[${new Date().toISOString()}] Master role requested by: ${client?.id}, wantsToBeMaster: ${data.wantsToBeMaster}`);
    
    // Update client preference
    if (client) {
      client.wantsToBeMaster = data.wantsToBeMaster || false;
    }
    
    if (!masterClient) {
      // Grant master role
      masterClient = socket.id;
      connectedClients.get(socket.id).isMaster = true;
      connectedClients.get(socket.id).wantsToBeMaster = true;
      
      socket.emit('master-role-granted', { 
        isMaster: true,
        clientId: client.id,
        message: 'Anda sekarang adalah Master Controller',
        autoReconnected: data.autoReconnect || false
      });
      
      io.emit('master-changed', { 
        masterClientId: client.id,
        masterSocketId: socket.id,
        timestamp: new Date().toISOString(),
        reason: 'manual-request'
      });
      
      console.log(`[${new Date().toISOString()}] Client ${client.id} is now master`);
      
      // Process any pending master requests
      if (masterRequestQueue.length > 0) {
        console.log(`Processing ${masterRequestQueue.length} pending requests`);
        masterRequestQueue.forEach(request => {
          socket.emit('tts-request', request);
        });
        masterRequestQueue = [];
      }
    } else {
      // Master already exists
      socket.emit('master-role-denied', {
        reason: 'Master controller sudah ada',
        currentMaster: connectedClients.get(masterClient)?.id,
        suggestion: 'Tunggu hingga master saat ini melepaskan peran'
      });
    }
  });
  
  // Handle release master role
  socket.on('release-master-role', (data) => {
    if (socket.id === masterClient) {
      const oldMasterId = connectedClients.get(masterClient)?.id;
      masterClient = null;
      connectedClients.get(socket.id).isMaster = false;
      
      // Update preference if specified
      if (data && data.clearPreference) {
        connectedClients.get(socket.id).wantsToBeMaster = false;
      }
      
      io.emit('master-released', {
        oldMasterId: oldMasterId,
        timestamp: new Date().toISOString(),
        message: 'Master controller telah melepaskan peran'
      });
      
      socket.emit('master-role-released', {
        isMaster: false,
        message: 'Anda telah melepaskan peran master',
        preferenceCleared: data ? data.clearPreference : false
      });
      
      console.log(`[${new Date().toISOString()}] Client ${oldMasterId} released master role`);
    }
  });
  
  // Handle TTS request from clients
  socket.on('tts-request', async (data) => {
    const client = connectedClients.get(socket.id);
    const { text, language = 'id-ID', speed = 1.0, priority = 'normal' } = data;
    
    console.log(`[${new Date().toISOString()}] TTS Request from ${client?.id}: ${language}, Text Length: ${text?.length || 0}`);
    
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
                text: trimmedText, // Gunakan teks yang sudah di-trim
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
        
        // Send audio to MASTER CLIENT only
        io.to(masterClient).emit('tts-audio', {
            ...result,
            fromClientId: client.id,
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
            textLength: text.length,
            language: language,
            duration: result.duration
        });
        
        // Notify all clients about new TTS (except sender and master)
        socket.broadcast.emit('tts-notification', {
            fromClientId: client.id,
            textPreview: text.length > 50 ? text.substring(0, 50) + '...' : text,
            language: language,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] TTS Error for ${client?.id}:`, error.message);
        
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
        broadcast: true,
        timestamp: new Date().toISOString()
      });
      
      console.log(`[${new Date().toISOString()}] Broadcast TTS from ${client.id} to all clients`);
      
    } catch (error) {
      console.error('Broadcast TTS Error:', error.message);
      socket.emit('tts-error', {
        success: false,
        error: 'Gagal melakukan broadcast TTS'
      });
    }
  });
  
  // Handle client requesting to play audio (master only)
  socket.on('play-audio', (audioData) => {
    if (socket.id === masterClient) {
      io.emit('play-audio-command', {
        ...audioData,
        issuedBy: connectedClients.get(socket.id)?.id,
        timestamp: new Date().toISOString()
      });
    } else {
      socket.emit('play-audio-denied', {
        reason: 'Hanya Master Controller yang dapat mengontrol pemutaran audio'
      });
    }
  });
  
  // Handle client requesting to stop audio
  socket.on('stop-audio', () => {
    if (socket.id === masterClient) {
      io.emit('stop-audio-command', {
        issuedBy: connectedClients.get(socket.id)?.id,
        timestamp: new Date().toISOString()
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
      clientId: client?.id
    });
  });
  
  // Handle disconnect with auto-reconnect data
  socket.on('disconnect', (reason) => {
    const client = connectedClients.get(socket.id);
    console.log(`[${new Date().toISOString()}] Client disconnected: ${client?.id || socket.id} - Reason: ${reason}`);
    
    // If master disconnects, clear master role but keep preference
    if (socket.id === masterClient) {
      const disconnectedMasterId = client?.id;
      const wantsToBeMaster = client?.wantsToBeMaster || false;
      masterClient = null;
      
      io.emit('master-disconnected', {
        disconnectedMasterId: disconnectedMasterId,
        wantsToBeMaster: wantsToBeMaster,
        timestamp: new Date().toISOString(),
        message: 'Master Controller terputus. Silakan klien lain mengambil alih peran master.'
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
    }
    
    // Remove from connected clients but keep track of preference?
    // Actually, we remove from connected clients but the client can store preference locally
    
    // Remove from connected clients
    connectedClients.delete(socket.id);
    
    // Notify remaining clients
    io.emit('client-disconnected', {
      clientId: client?.id,
      totalClients: connectedClients.size,
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
      
      if (socketId === masterClient) {
        masterClient = null;
        io.emit('master-inactive', {
          inactiveClientId: client.id,
          timestamp: now.toISOString()
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
    service: 'Multi-Client TTS Server v2.0',
    serverUptime: process.uptime(),
    connectedClients: connectedClients.size,
    masterClient: masterClient ? connectedClients.get(masterClient)?.id : null,
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
    masterClient: masterClient ? connectedClients.get(masterClient)?.id : null,
    masterSocketId: masterClient,
    pendingRequests: masterRequestQueue.length,
    clients: clients
  });
});

app.post('/api/set-master', (req, res) => {
  const { clientId, force = false } = req.body;
  
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
  
  // Set as master
  const oldMaster = masterClient;
  masterClient = targetSocketId;
  
  // Update client status
  connectedClients.forEach((client, socketId) => {
    client.isMaster = (socketId === targetSocketId);
    if (socketId === targetSocketId) {
      client.wantsToBeMaster = true;
    }
  });
  
  // Notify all clients
  io.emit('master-changed', {
    masterClientId: clientId,
    masterSocketId: targetSocketId,
    oldMasterId: oldMaster ? connectedClients.get(oldMaster)?.id : null,
    timestamp: new Date().toISOString(),
    changedBy: 'api',
    forced: force
  });
  
  res.json({
    success: true,
    message: `Client ${clientId} sekarang menjadi Master Controller`,
    masterClient: clientId,
    forced: force
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
                broadcast: true,
                timestamp: new Date().toISOString()
            });
        } else if (masterClient) {
            io.to(masterClient).emit('tts-audio', {
                ...result,
                fromClientId: 'api-request',
                timestamp: new Date().toISOString(),
                priority: 'high'
            });
        }
        
        res.json({
            ...result,
            broadcasted: broadcast,
            masterClient: masterClient ? connectedClients.get(masterClient)?.id : null,
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
    masterClient: masterClient ? connectedClients.get(masterClient)?.id : null,
    pendingRequests: masterRequestQueue.length,
    serverUptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    activeSince: new Date(Date.now() - process.uptime() * 1000).toISOString()
  };
  
  res.json({
    success: true,
    stats: stats
  });
});

// New API endpoint to get master preference
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
      isMaster: client.isMaster || false
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
  console.log(`   Multi-Client TTS Server v2.0`);
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
  console.log(`   POST ${serverUrl}/api/set-master  - Atur client sebagai master`);
  console.log(`   POST ${serverUrl}/api/tts         - Konversi teks ke suara`);
  console.log(`   GET  ${serverUrl}/api/languages   - Daftar bahasa yang didukung`);
  console.log(`   POST ${serverUrl}/api/clear-queue - Hapus antrian TTS`);
  console.log(`\n🌐 Frontend tersedia di: ${serverUrl}`);
  console.log(`\n🔧 Fitur Baru: Master Auto-Reconnect`);
  console.log(`   • Master preference disimpan di localStorage`);
  console.log(`   • Auto-reconnect saat browser di-refresh`);
  console.log(`   • Otomatis request master role saat tersedia`);
  console.log(`\n========================================\n`);
});