function ttsApp() {
    return {
        // State
        socket: null,
        clientId: null,
        clientShortId: '', // ID pendek
        isMaster: false,
        isRequestingMaster: false,
        serverStatus: 'disconnected',
        serverStatusText: 'Menyambung ke server...',
        
        // UI State
        text: '',
        language: 'id-ID',
        speed: 1.0,
        priority: 'normal',
        isLoading: false,
        isPlaying: false,
        currentAudio: null,
        
        // Data
        connectedClients: [],
        masterClientId: null,
        masterShortId: null, // ID pendek master
        languages: [],
        history: [],
        notifications: [],
        
        // UI Controls
        charCount: 0,
        maxChars: 5000,
        wordCount: 0,
        showSystemInfoModal: false,
        showHelpModal: false,
        
        // Master Recovery State
        wasMasterBeforeDisconnect: false,
        masterAutoRecoveryAttempts: 0,
        maxAutoRecoveryAttempts: 3,
        isAttemptingMasterRecovery: false,
        lastMasterStatus: null,
        
        // Initialize
        init() {
            this.updateCharCount();
            this.loadLanguages();
            this.loadHistory();
            
            // Load master status dari localStorage
            this.loadMasterStatus();
            
            this.initSocket();
            
            // Auto-reconnect jika terputus - lebih agresif jika sebelumnya master
            setInterval(() => {
                if (!this.socket || !this.socket.connected) {
                    this.serverStatus = 'disconnected';
                    this.serverStatusText = 'Mencoba menyambung ulang...';
                    
                    // Jika sebelumnya master, coba reconnect lebih cepat
                    if (this.wasMasterBeforeDisconnect) {
                        this.initSocket();
                    }
                }
            }, this.wasMasterBeforeDisconnect ? 3000 : 5000);
            
            // Send periodic ping dengan status master
            setInterval(() => {
                if (this.socket && this.socket.connected) {
                    this.socket.emit('ping', { 
                        timestamp: Date.now(),
                        isMaster: this.isMaster,
                        wasMasterBeforeDisconnect: this.wasMasterBeforeDisconnect
                    });
                }
            }, 30000);
            
            // Monitor master status untuk recovery
            setInterval(() => {
                if (this.wasMasterBeforeDisconnect && !this.isMaster && this.serverStatus === 'connected') {
                    // Jika sudah terhubung tapi belum menjadi master, coba recovery
                    if (!this.isAttemptingMasterRecovery && this.masterAutoRecoveryAttempts < this.maxAutoRecoveryAttempts) {
                        this.attemptMasterRecovery();
                    }
                }
            }, 10000);
        },
        
        // Load master status dari localStorage
        loadMasterStatus() {
            try {
                const savedWasMaster = localStorage.getItem('wasMaster');
                const savedAttempts = localStorage.getItem('masterRecoveryAttempts');
                const savedMasterInfo = localStorage.getItem('lastMasterInfo');
                
                if (savedWasMaster === 'true') {
                    this.wasMasterBeforeDisconnect = true;
                    this.masterAutoRecoveryAttempts = parseInt(savedAttempts || '0');
                }
                
                if (savedMasterInfo) {
                    this.lastMasterStatus = JSON.parse(savedMasterInfo);
                }
            } catch (error) {
                console.error('Failed to load master status:', error);
            }
        },
        
        // Save master status ke localStorage
        saveMasterStatus() {
            try {
                localStorage.setItem('wasMaster', this.wasMasterBeforeDisconnect.toString());
                localStorage.setItem('masterRecoveryAttempts', this.masterAutoRecoveryAttempts.toString());
                
                const masterInfo = {
                    clientId: this.clientId,
                    shortId: this.clientShortId,
                    timestamp: new Date().toISOString(),
                    isMaster: this.isMaster
                };
                localStorage.setItem('lastMasterInfo', JSON.stringify(masterInfo));
            } catch (error) {
                console.error('Failed to save master status:', error);
            }
        },
        
        // Clear master status
        clearMasterStatus() {
            this.wasMasterBeforeDisconnect = false;
            this.masterAutoRecoveryAttempts = 0;
            this.isAttemptingMasterRecovery = false;
            
            localStorage.removeItem('wasMaster');
            localStorage.removeItem('masterRecoveryAttempts');
            localStorage.removeItem('lastMasterInfo');
        },
        
        // Initialize Socket.io connection
        initSocket() {
            // Close existing connection
            if (this.socket) {
                this.socket.disconnect();
            }
            
            // Create new connection
            this.socket = io({
                reconnection: true,
                reconnectionAttempts: 10,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                timeout: 20000,
                transports: ['websocket', 'polling']
            });
            
            // Socket event listeners
            this.socket.on('connect', () => {
                this.serverStatus = 'connected';
                this.serverStatusText = 'Terhubung ke server';
                console.log('Socket connected:', this.socket.id);
                
                // Send client info
                this.socket.emit('client-info', {
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    screen: `${window.screen.width}x${window.screen.height}`,
                    url: window.location.href,
                    wasMaster: this.wasMasterBeforeDisconnect,
                    recoveryAttempts: this.masterAutoRecoveryAttempts
                });
                
                // Jika sebelumnya adalah master dan terputus, coba recovery
                if (this.wasMasterBeforeDisconnect && !this.isAttemptingMasterRecovery && !this.isMaster) {
                    setTimeout(() => {
                        this.attemptMasterRecovery();
                    }, 2000);
                }
            });
            
            this.socket.on('reconnect', (attemptNumber) => {
                console.log('Socket reconnected, attempt:', attemptNumber);
                this.serverStatus = 'connected';
                this.serverStatusText = 'Terhubung kembali ke server';
                
                // Jika sebelumnya master, coba recovery
                if (this.wasMasterBeforeDisconnect && !this.isAttemptingMasterRecovery && !this.isMaster) {
                    this.attemptMasterRecovery();
                }
            });
            
            this.socket.on('reconnect_attempt', (attemptNumber) => {
                console.log('Attempting to reconnect:', attemptNumber);
                this.serverStatus = 'reconnecting';
                this.serverStatusText = `Menyambung ulang... (Percobaan ${attemptNumber})`;
                
                // Jika sebelumnya master, update status
                if (this.wasMasterBeforeDisconnect) {
                    this.serverStatusText = `Master mencoba menyambung ulang... (Percobaan ${attemptNumber})`;
                }
            });
            
            this.socket.on('reconnect_error', (error) => {
                console.error('Reconnection error:', error);
                this.serverStatus = 'error';
                this.serverStatusText = 'Gagal menyambung ulang';
            });
            
            this.socket.on('reconnect_failed', () => {
                console.error('Reconnection failed');
                this.serverStatus = 'failed';
                this.serverStatusText = 'Gagal total menyambung ulang';
                
                // Reset status jika gagal total
                if (this.wasMasterBeforeDisconnect && this.masterAutoRecoveryAttempts >= this.maxAutoRecoveryAttempts) {
                    this.clearMasterStatus();
                    this.showNotification('Gagal mengembalikan status Master. Silakan request manual.', 'error');
                }
            });
            
            this.socket.on('welcome', (data) => {
                this.clientId = data.clientId;
                this.clientShortId = data.shortClientId || this.formatClientId(data.clientId);
                this.showNotification('Terhubung ke server TTS Multi-Client', 'success');
                
                // Tampilkan info apakah sudah ada master
                if (data.hasMaster && data.masterShortId) {
                    this.showNotification(`Master aktif: ${data.masterShortId}. Anda dapat mengirim teks ke master.`, 'info');
                }
                
                // Jika server mendukung recovery dan client sebelumnya adalah master
                if (data.supportsRecovery && this.wasMasterBeforeDisconnect) {
                    this.showNotification('Sistem mendukung recovery Master. Status Anda akan dicoba dikembalikan.', 'info');
                }
            });
            
            this.socket.on('connection-status', (data) => {
                this.clientId = data.clientId;
                this.clientShortId = data.shortClientId || this.formatClientId(data.clientId);
                this.isMaster = data.isMaster;
                this.masterClientId = data.masterClient;
                this.masterShortId = data.masterShortId;
                this.connectedClients = data.connectedClients || [];
                
                // Update master status
                if (this.isMaster) {
                    this.wasMasterBeforeDisconnect = true;
                    this.masterAutoRecoveryAttempts = 0;
                    this.isAttemptingMasterRecovery = false;
                    this.saveMasterStatus();
                }
            });
            
            this.socket.on('client-connected', (data) => {
                this.connectedClients = data.connectedClients || [];
                const newClientShortId = data.shortClientId || this.formatClientId(data.clientId);
                this.showNotification(`Komputer baru terhubung: ${newClientShortId}`, 'info');
            });
            
            this.socket.on('client-disconnected', (data) => {
                this.connectedClients = data.connectedClients || [];
                const disconnectedShortId = data.clientShortId || this.formatClientId(data.clientId);
                this.showNotification(`Komputer terputus: ${disconnectedShortId}`, 'warning');
            });
            
            this.socket.on('master-changed', (data) => {
                this.masterClientId = data.masterClientId;
                this.masterShortId = data.masterShortId;
                this.isMaster = (this.clientId === data.masterClientId);
                
                if (this.isMaster) {
                    this.wasMasterBeforeDisconnect = true;
                    this.masterAutoRecoveryAttempts = 0;
                    this.isAttemptingMasterRecovery = false;
                    this.saveMasterStatus();
                    
                    const message = data.isRecovery ? 
                        'Status Master berhasil dikembalikan!' : 
                        'Anda sekarang adalah Master Controller! Audio hanya akan diputar di komputer ini.';
                    this.showNotification(message, 'success');
                } else if (data.masterShortId) {
                    this.showNotification(`${data.masterShortId} sekarang menjadi Master`, 'info');
                }
            });
            
            this.socket.on('master-role-granted', (data) => {
                this.isMaster = true;
                this.isRequestingMaster = false;
                this.isAttemptingMasterRecovery = false;
                this.masterAutoRecoveryAttempts = 0;
                this.wasMasterBeforeDisconnect = true;
                this.masterClientId = this.clientId;
                this.masterShortId = data.shortClientId || this.formatClientId(data.clientId);
                
                const message = data.isRecovery ? 
                    'Status Master berhasil dikembalikan!' : 
                    'Anda sekarang adalah Master Controller! Audio hanya akan diputar di komputer ini.';
                
                this.showNotification(message, 'success');
                this.saveMasterStatus();
                
                // Clear any pending recovery attempts
                this.clearRecoveryTimeout();
            });
            
            this.socket.on('master-role-denied', (data) => {
                this.isRequestingMaster = false;
                this.isAttemptingMasterRecovery = false;
                
                let message = `Gagal menjadi Master: ${data.reason}`;
                
                // Tampilkan ID master yang sedang aktif
                if (data.currentMasterShortId) {
                    message += ` (Master aktif: ${data.currentMasterShortId})`;
                }
                
                this.showNotification(message, 'error');
                
                // Jika ini recovery attempt, coba lagi nanti
                if (data.isRecoveryAttempt && this.wasMasterBeforeDisconnect) {
                    if (this.masterAutoRecoveryAttempts < this.maxAutoRecoveryAttempts) {
                        setTimeout(() => {
                            this.attemptMasterRecovery();
                        }, 10000); // Coba lagi dalam 10 detik
                    } else {
                        this.showNotification('Gagal mengembalikan status Master setelah beberapa percobaan', 'warning');
                        this.clearMasterStatus();
                    }
                }
            });
            
            this.socket.on('master-role-released', (data) => {
                this.isMaster = false;
                this.masterClientId = null;
                this.masterShortId = null;
                
                // Hanya clear jika sengaja melepas
                if (data.isIntentional) {
                    this.clearMasterStatus();
                }
                
                this.showNotification(data.message || 'Anda telah melepaskan peran Master', 'info');
            });
            
            this.socket.on('master-disconnected', (data) => {
                // Jika master yang terputus adalah diri sendiri, tandai untuk recovery
                if (this.isMaster || this.clientId === data.disconnectedMasterId) {
                    this.wasMasterBeforeDisconnect = true;
                    this.isMaster = false;
                    this.saveMasterStatus();
                    
                    if (data.canRecover) {
                        this.showNotification('Anda terputus sebagai Master. Mencoba mengembalikan dalam 5 detik...', 'warning');
                        
                        // Tunggu 5 detik sebelum mencoba recovery
                        setTimeout(() => {
                            this.attemptMasterRecovery();
                        }, 5000);
                    }
                }
                
                this.masterClientId = null;
                this.masterShortId = null;
                const disconnectedShortId = data.disconnectedMasterShortId || this.formatClientId(data.disconnectedMasterId);
                this.showNotification(`Master Controller terputus: ${disconnectedShortId}`, 'warning');
            });
            
            this.socket.on('master-released', (data) => {
                // Jika master sengaja melepas peran, reset status
                if (data.wasIntentional && data.oldMasterId === this.clientId) {
                    this.clearMasterStatus();
                }
            });
            
            this.socket.on('master-needed', (data) => {
                if (!this.isMaster) {
                    // Jika sebelumnya master, coba ambil kembali
                    if (this.wasMasterBeforeDisconnect) {
                        this.showNotification(`Master diperlukan! Anda sebelumnya adalah Master. Mencoba mengembalikan...`, 'warning');
                        this.attemptMasterRecovery();
                    } else {
                        this.showNotification(`Master diperlukan! ${data.pendingRequests} permintaan dalam antrian.`, 'warning');
                    }
                }
            });
            
            this.socket.on('tts-audio', (data) => {
                console.log('Received TTS audio:', data);
                
                // Store the audio data
                this.currentAudio = data;
                
                // Hanya tampilkan notifikasi, jangan auto-play
                if (this.isMaster) {
                    const fromClientShortId = data.fromClientShortId || this.formatClientId(data.fromClientId);
                    this.showNotification(`Menerima audio dari ${fromClientShortId}. Klik "Putar Audio" untuk memutar.`, 'info');
                }
            });
            
            this.socket.on('play-audio-master', (data) => {
                // Hanya master yang menerima ini
                if (this.isMaster) {
                    this.currentAudio = data;
                    this.playAudioLocal(); // Play hanya di master
                }
            });
            
            this.socket.on('tts-audio-broadcast', (data) => {
                this.currentAudio = data;
                const fromClientShortId = data.fromClientShortId || this.formatClientId(data.fromClientId);
                this.showNotification(`Broadcast audio dari ${fromClientShortId}`, 'info');
                
                // Auto-play broadcast untuk semua client
                this.playAudioLocal();
            });
            
            this.socket.on('tts-complete', (data) => {
                this.isLoading = false;
                
                // Add to history
                this.addToHistory({
                    text: this.text,
                    language: this.language,
                    speed: this.speed,
                    success: true,
                    timestamp: new Date().toISOString(),
                    master: data.masterShortId || this.formatClientId(data.masterClientId),
                    message: data.message
                });
                
                this.showNotification(data.message || 'TTS berhasil dikirim ke Master', 'success');
                
                // Clear text if successful
                if (data.success) {
                    this.text = '';
                    this.updateCharCount();
                }
            });
            
            this.socket.on('tts-queued', (data) => {
                this.isLoading = false;
                this.showNotification(data.message || 'TTS dalam antrian', 'info');
                
                this.addToHistory({
                    text: this.text,
                    language: this.language,
                    speed: this.speed,
                    success: false,
                    timestamp: new Date().toISOString(),
                    message: data.message,
                    queuePosition: data.queuePosition
                });
            });
            
            this.socket.on('tts-error', (data) => {
                this.isLoading = false;
                this.showNotification(data.error || 'Terjadi kesalahan pada TTS', 'error');
                
                this.addToHistory({
                    text: this.text,
                    language: this.language,
                    speed: this.speed,
                    success: false,
                    timestamp: new Date().toISOString(),
                    error: data.error
                });
            });
            
            this.socket.on('play-audio-command', (data) => {
                // Untuk broadcast ke semua client
                if (data.isBroadcast && this.currentAudio) {
                    this.playAudioLocal();
                }
            });
            
            this.socket.on('stop-audio-command', () => {
                this.stopAudio();
            });
            
            this.socket.on('tts-notification', (data) => {
                if (data.fromClientId !== this.clientId) {
                    const fromClientShortId = data.fromClientShortId || this.formatClientId(data.fromClientId);
                    this.showNotification(`${fromClientShortId} mengirim teks: "${data.textPreview}"`, 'info');
                }
            });
            
            this.socket.on('pong', (data) => {
                // Update last activity
                console.log('Pong received:', data);
            });
            
            this.socket.on('disconnect', (reason) => {
                // Jika saat disconnect adalah master, tandai untuk recovery
                if (this.isMaster) {
                    this.wasMasterBeforeDisconnect = true;
                    this.saveMasterStatus();
                    this.showNotification('Koneksi terputus. Akan mencoba kembali menjadi Master...', 'warning');
                }
                
                this.serverStatus = 'disconnected';
                this.serverStatusText = 'Terputus dari server';
                this.showNotification('Terputus dari server. Mencoba menyambung ulang...', 'error');
                console.log('Socket disconnected:', reason);
                
                // Clear recovery timeout
                this.clearRecoveryTimeout();
            });
            
            this.socket.on('connect_error', (error) => {
                this.serverStatus = 'error';
                this.serverStatusText = 'Gagal menyambung ke server';
                console.error('Connection error:', error);
            });
            
            this.socket.on('error', (error) => {
                console.error('Socket error:', error);
                this.showNotification('Kesalahan koneksi socket', 'error');
            });
            
            // Master recovery events
            this.socket.on('master-recovery-available', (data) => {
                if (this.wasMasterBeforeDisconnect && !this.isMaster) {
                    this.showNotification('Recovery Master tersedia. Mencoba mengembalikan...', 'info');
                    this.attemptMasterRecovery();
                }
            });
            
            this.socket.on('master-recovery-success', (data) => {
                this.isMaster = true;
                this.wasMasterBeforeDisconnect = true;
                this.masterAutoRecoveryAttempts = 0;
                this.isAttemptingMasterRecovery = false;
                this.saveMasterStatus();
                
                this.showNotification('Status Master berhasil dipulihkan secara otomatis!', 'success');
            });
        },
        
        // Recovery timeout handler
        recoveryTimeout: null,
        
        // Clear recovery timeout
        clearRecoveryTimeout() {
            if (this.recoveryTimeout) {
                clearTimeout(this.recoveryTimeout);
                this.recoveryTimeout = null;
            }
        },
        
        // Attempt master recovery
        attemptMasterRecovery() {
            if (this.isAttemptingMasterRecovery || this.isMaster) return;
            
            this.isAttemptingMasterRecovery = true;
            this.masterAutoRecoveryAttempts++;
            
            if (this.masterAutoRecoveryAttempts > this.maxAutoRecoveryAttempts) {
                this.showNotification('Gagal mengembalikan status Master setelah beberapa percobaan', 'warning');
                this.clearMasterStatus();
                this.isAttemptingMasterRecovery = false;
                return;
            }
            
            this.showNotification(`Mencoba mengembalikan status Master... (Percobaan ${this.masterAutoRecoveryAttempts})`, 'info');
            
            // Tunggu 2 detik untuk memastikan koneksi stabil
            this.recoveryTimeout = setTimeout(() => {
                if (this.socket && this.socket.connected) {
                    this.requestMasterRole(true);
                    
                    // Timeout jika tidak ada respon
                    setTimeout(() => {
                        if (this.isAttemptingMasterRecovery && !this.isMaster) {
                            this.isAttemptingMasterRecovery = false;
                            if (this.masterAutoRecoveryAttempts < this.maxAutoRecoveryAttempts) {
                                this.showNotification('Timeout recovery, akan mencoba lagi dalam 10 detik...', 'warning');
                                setTimeout(() => this.attemptMasterRecovery(), 10000);
                            }
                        }
                    }, 8000);
                } else {
                    this.isAttemptingMasterRecovery = false;
                }
            }, 2000);
        },
        
        // Request master role
        requestMasterRole(isRecovery = false) {
            if (this.isMaster) return;
            
            this.isRequestingMaster = true;
            this.socket.emit('request-master-role', {
                timestamp: new Date().toISOString(),
                clientId: this.clientId,
                shortClientId: this.clientShortId,
                isRecoveryAttempt: isRecovery,
                previousMaster: isRecovery ? this.wasMasterBeforeDisconnect : false,
                recoveryAttempts: this.masterAutoRecoveryAttempts
            });
            
            const message = isRecovery ? 
                'Mencoba mengembalikan status Master...' : 
                'Mengirim permintaan menjadi Master...';
            this.showNotification(message, 'info');
        },
        
        // Release master role
        releaseMasterRole() {
            if (!this.isMaster) return;
            
            this.socket.emit('release-master-role', {
                isIntentional: true,
                timestamp: new Date().toISOString(),
                clientId: this.clientId,
                shortClientId: this.clientShortId
            });
            
            this.isMaster = false;
            this.masterClientId = null;
            this.masterShortId = null;
            this.clearMasterStatus();
        },
        
        // Force master recovery (manual)
        forceMasterRecovery() {
            this.clearMasterStatus();
            this.wasMasterBeforeDisconnect = true;
            this.masterAutoRecoveryAttempts = 0;
            this.saveMasterStatus();
            this.attemptMasterRecovery();
        },
        
        // Convert text to speech and send to master
        async convertToSpeech() {
            if (!this.text || !this.text.trim()) {
                this.showNotification('Silakan masukkan teks terlebih dahulu', 'error');
                return;
            }
            
            // Validasi panjang teks (5000 karakter maksimal)
            if (this.text.length > 5000) {
                this.showNotification(`Teks terlalu panjang. Maksimal 5000 karakter. Saat ini: ${this.text.length}`, 'error');
                return;
            }
            
            // Validasi jika teks hanya whitespace
            if (this.text.trim().length === 0) {
                this.showNotification('Teks tidak boleh hanya spasi atau karakter kosong', 'error');
                return;
            }
            
            // Jika tidak ada master, beri tahu user
            if (!this.masterShortId) {
                this.showNotification('Tidak ada Master yang aktif. Silakan tunggu atau jadikan diri Anda Master.', 'warning');
                return;
            }
            
            this.isLoading = true;
            
            try {
                // Send TTS request via Socket.io
                this.socket.emit('tts-request', {
                    text: this.text.trim(), // Trim whitespace
                    language: this.language,
                    speed: Math.max(0.5, Math.min(parseFloat(this.speed) || 1.0, 2.0)),
                    priority: this.priority,
                    timestamp: new Date().toISOString(),
                    fromClientId: this.clientId,
                    fromClientShortId: this.clientShortId
                });
                
                this.showNotification('Mengirim permintaan TTS...', 'info');
                
            } catch (error) {
                this.isLoading = false;
                this.showNotification(`Gagal mengirim: ${error.message}`, 'error');
                console.error('TTS Error:', error);
            }
        },
        
        // Convert and broadcast to all clients (master only)
        convertAndBroadcast() {
            if (!this.isMaster) {
                this.showNotification('Hanya Master yang dapat melakukan broadcast', 'error');
                return;
            }
            
            if (!this.text.trim()) {
                this.showNotification('Silakan masukkan teks terlebih dahulu', 'error');
                return;
            }
            
            this.socket.emit('tts-broadcast', {
                text: this.text,
                language: this.language,
                speed: this.speed,
                timestamp: new Date().toISOString(),
                fromClientId: this.clientId,
                fromClientShortId: this.clientShortId
            });
            
            this.showNotification('Mengirim broadcast ke semua komputer...', 'info');
        },
        
        // Play audio (master only - hanya di master)
        playAudio() {
            if (!this.currentAudio || !this.currentAudio.audioUrl) {
                this.showNotification('Tidak ada audio untuk diputar', 'error');
                return;
            }
            
            // Jika ini master, kirim perintah untuk play lokal saja
            if (this.isMaster) {
                this.socket.emit('play-audio-master-only', this.currentAudio);
            } else {
                this.showNotification('Hanya Master yang dapat memutar audio', 'error');
            }
        },
        
        // Play audio hanya di local (tidak broadcast)
        playAudioLocal() {
            if (!this.currentAudio || !this.currentAudio.audioUrl) {
                this.showNotification('Tidak ada audio untuk diputar', 'error');
                return;
            }
            
            const audioElement = this.isMaster ? 
                document.getElementById('masterAudioPlayer') : 
                document.getElementById('hiddenAudio');
            
            if (audioElement) {
                audioElement.src = this.currentAudio.audioUrl;
                audioElement.play().then(() => {
                    this.isPlaying = true;
                    this.showNotification('Memutar audio...', 'success');
                }).catch(error => {
                    console.error('Play error:', error);
                    this.showNotification('Gagal memutar audio: ' + error.message, 'error');
                });
            }
        },
        
        // Pause audio
        pauseAudio() {
            const audioElement = this.isMaster ? 
                document.getElementById('masterAudioPlayer') : 
                document.getElementById('hiddenAudio');
                
            if (audioElement) {
                audioElement.pause();
                this.isPlaying = false;
                this.socket.emit('audio-status', 'paused');
            }
        },
        
        // Stop audio
        stopAudio() {
            const audioElement = this.isMaster ? 
                document.getElementById('masterAudioPlayer') : 
                document.getElementById('hiddenAudio');
                
            if (audioElement) {
                audioElement.pause();
                audioElement.currentTime = 0;
                this.isPlaying = false;
                this.socket.emit('audio-status', 'stopped');
                
                // Jika ini master, notify others to stop (untuk broadcast)
                if (this.isMaster) {
                    this.socket.emit('stop-audio');
                }
            }
        },
        
        // Audio event handlers
        onAudioPlay() {
            this.isPlaying = true;
        },
        
        onAudioPause() {
            this.isPlaying = false;
        },
        
        onAudioEnd() {
            this.isPlaying = false;
            this.showNotification('Audio selesai diputar', 'info');
        },
        
        // Download audio
        downloadAudio() {
            if (!this.currentAudio || !this.currentAudio.audioUrl) return;
            
            const link = document.createElement('a');
            link.href = this.currentAudio.audioUrl;
            const fromClientShortId = this.currentAudio.fromClientShortId || this.formatClientId(this.currentAudio.fromClientId);
            const filename = `tts-${fromClientShortId}-${Date.now()}.mp3`;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            this.showNotification('Audio berhasil diunduh', 'success');
        },
        
        // Share audio info
        shareAudio() {
            if (!this.currentAudio) return;
            
            const fromClientShortId = this.currentAudio.fromClientShortId || this.formatClientId(this.currentAudio.fromClientId);
            const shareText = `TTS dari ${fromClientShortId}: ${this.text.substring(0, 50)}...`;
            
            if (navigator.share) {
                navigator.share({
                    title: 'Hasil Konversi TTS',
                    text: shareText,
                    url: window.location.href
                });
            } else {
                navigator.clipboard.writeText(shareText);
                this.showNotification('Teks berhasil disalin ke clipboard', 'success');
            }
        },
        
        // Clear audio
        clearAudio() {
            this.currentAudio = null;
            this.isPlaying = false;
        },
        
        // Show notification
        showNotification(message, type = 'info') {
            const notification = {
                id: Date.now() + Math.random(),
                message: message,
                type: type,
                timestamp: new Date().toISOString()
            };
            
            this.notifications.push(notification);
            
            // Auto-remove after 5 seconds
            setTimeout(() => {
                this.removeNotification(notification.id);
            }, 5000);
        },
        
        // Remove notification
        removeNotification(id) {
            this.notifications = this.notifications.filter(n => n.id !== id);
        },
        
        // Get notification icon
        getNotificationIcon(type) {
            const icons = {
                success: 'fa-check-circle',
                error: 'fa-exclamation-circle',
                warning: 'fa-exclamation-triangle',
                info: 'fa-info-circle'
            };
            return icons[type] || 'fa-info-circle';
        },
        
        // Get convert button text
        getConvertButtonText() {
            if (this.isLoading) return 'Memproses...';
            if (this.masterShortId) return `Kirim ke Master (${this.masterShortId})`;
            return 'Kirim ke Master';
        },
        
        // Get isMasterReady
        get isMasterReady() {
            return this.isMaster && this.currentAudio;
        },
        
        // Helper methods
        updateCharCount() {
            if (!this.text) {
                this.charCount = 0;
                this.wordCount = 0;
                return;
            }
            
            // Hitung karakter (termasuk spasi)
            this.charCount = this.text.length;
            
            // Hitung kata (hanya karakter non-whitespace)
            const trimmed = this.text.trim();
            this.wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
        },
        
        // Format client ID to short version
        formatClientId(clientId) {
            if (!clientId) return '';
            // Tampilkan hanya 8 karakter pertama
            return clientId.length > 8 ? clientId.substring(0, 8) + '...' : clientId;
        },
        
        clearText() {
            this.text = '';
            this.updateCharCount();
        },
        
        async pasteText() {
            try {
                const text = await navigator.clipboard.readText();
                this.text = text;
                this.updateCharCount();
                this.showNotification('Teks berhasil ditempel', 'success');
            } catch (error) {
                this.showNotification('Gagal membaca dari clipboard', 'error');
            }
        },
        
        loadExample() {
            const examples = [
                "Halo, selamat datang di sistem TTS Multi-Client.",
                "Audio dari semua komputer akan diputar di satu komputer master.",
                "Silakan masukkan teks Anda di sini untuk dikonversi menjadi suara.",
                "Sistem ini mendukung berbagai bahasa dan kecepatan pengucapan."
            ];
            
            this.text = examples[Math.floor(Math.random() * examples.length)];
            this.updateCharCount();
        },
        
        truncateText(text, length) {
            if (!text) return '';
            return text.length > length ? text.substring(0, length) + '...' : text;
        },
        
        getLanguageName(code) {
            const langMap = {
                'id-ID': 'Bahasa Indonesia',
                'en-US': 'English (US)',
                'en-GB': 'English (UK)',
                'es-ES': 'Spanish',
                'fr-FR': 'French',
                'de-DE': 'German',
                'it-IT': 'Italian',
                'pt-BR': 'Portuguese (BR)',
                'ru-RU': 'Russian',
                'ja-JP': 'Japanese',
                'ko-KR': 'Korean',
                'zh-CN': 'Chinese',
                'ar-SA': 'Arabic',
                'hi-IN': 'Hindi',
                'th-TH': 'Thai',
                'vi-VN': 'Vietnamese',
                'ms-MY': 'Malay'
            };
            return langMap[code] || code;
        },
        
        getLanguageCode(lang) {
            return lang ? lang.split('-')[0] : '';
        },
        
        formatTime(timestamp) {
            if (!timestamp) return '';
            const date = new Date(timestamp);
            return date.toLocaleTimeString('id-ID', { 
                hour: '2-digit', 
                minute: '2-digit',
                second: '2-digit'
            });
        },
        
        loadHistoryItem(item) {
            this.text = item.text;
            this.language = item.language;
            this.speed = item.speed;
            this.updateCharCount();
            this.showNotification('Teks dimuat dari riwayat', 'info');
        },
        
        removeHistoryItem(id) {
            this.history = this.history.filter(item => item.id !== id);
            localStorage.setItem('ttsHistory', JSON.stringify(this.history));
        },
        
        clearHistory() {
            if (confirm('Apakah Anda yakin ingin menghapus semua riwayat?')) {
                this.history = [];
                localStorage.removeItem('ttsHistory');
                this.showNotification('Riwayat berhasil dihapus', 'success');
            }
        },
        
        addToHistory(item) {
            const historyItem = {
                ...item,
                id: Date.now() + Math.random()
            };
            
            this.history.push(historyItem);
            
            // Keep only last 50 items
            if (this.history.length > 50) {
                this.history = this.history.slice(-50);
            }
            
            localStorage.setItem('ttsHistory', JSON.stringify(this.history));
        },
        
        loadHistory() {
            try {
                const saved = localStorage.getItem('ttsHistory');
                if (saved) {
                    this.history = JSON.parse(saved);
                }
            } catch (error) {
                console.error('Failed to load history:', error);
                this.history = [];
            }
        },
        
        async loadLanguages() {
            try {
                const response = await fetch('/api/languages');
                const data = await response.json();
                if (data.success) {
                    this.languages = data.languages;
                }
            } catch (error) {
                console.error('Failed to load languages:', error);
                // Fallback to default languages
                this.languages = [
                    { code: 'id-ID', name: 'Bahasa Indonesia', nativeName: 'Bahasa Indonesia' },
                    { code: 'en-US', name: 'English (US)', nativeName: 'English' }
                ];
            }
        },
        
        async testConnection() {
            try {
                const response = await fetch('/api/test');
                const data = await response.json();
                alert(data.message || 'Koneksi berhasil diuji');
            } catch (error) {
                alert('Gagal menguji koneksi: ' + error.message);
            }
        },
        
        showSystemInfo() {
            this.showSystemInfoModal = true;
        },
        
        showHelp() {
            this.showHelpModal = true;
        },
        
        // Master status methods
        getMasterStatusText() {
            if (this.isMaster) return 'Anda adalah Master Aktif';
            if (this.wasMasterBeforeDisconnect && !this.isMaster) return 'Mencoba mengembalikan status Master...';
            return 'Anda bukan Master';
        },
        
        getMasterStatusColor() {
            if (this.isMaster) return 'bg-green-100 text-green-800 border-green-300';
            if (this.wasMasterBeforeDisconnect && !this.isMaster) return 'bg-yellow-100 text-yellow-800 border-yellow-300';
            return 'bg-gray-100 text-gray-800 border-gray-300';
        },
        
        getMasterStatusIcon() {
            if (this.isMaster) return 'fa-crown';
            if (this.wasMasterBeforeDisconnect && !this.isMaster) return 'fa-sync-alt';
            return 'fa-user';
        }
    };
}