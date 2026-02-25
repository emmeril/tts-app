function ttsApp() {
    return {
        // State
        socket: null,
        clientId: null,
        clientIdShort: '',
        isMaster: false,
        isRequestingMaster: false,
        serverStatus: 'disconnected',
        serverStatusText: 'Menyambung ke server...',
        
        // Master Preference State
        wantsToBeMaster: false,
        autoRequestMaster: true,
        reconnectAttempts: 0,
        maxReconnectAttempts: 3,
        wasMasterBeforeDisconnect: false,
        savedClientId: null,
        
        // Multi-Master State
        masterClients: [], // Daftar semua master
        
        // UI State
        text: '',
        language: 'id-ID',
        speed: 1.0,
        priority: 'normal',
        isLoading: false,
        isPlaying: false,
        currentAudio: null,
        
        // Mobile Menu State
        showMobileMenu: false,
        
        // Data
        connectedClients: [],
        languages: [],
        history: [],
        notifications: [],
        
        // UI Controls
        charCount: 0,
        maxChars: 5000,
        wordCount: 0,
        showSystemInfoModal: false,
        showHelpModal: false,
        showMasterPreferenceModal: false,
        showMasterListModal: false,
        
        // Audio Control
        playRetryCount: 0,
        maxPlayRetries: 3,
        intervalsInitialized: false,
        
        // Initialize
        init() {
            this.updateCharCount();
            this.loadLanguages();
            this.loadHistory();
            this.loadMasterPreference();
            this.loadAudioState();
            this.loadClientId();

            if (!this.intervalsInitialized) {
                // Auto-reconnect jika terputus
                setInterval(() => {
                    if (!this.socket || !this.socket.connected) {
                        this.serverStatus = 'disconnected';
                        this.serverStatusText = 'Mencoba menyambung ulang...';
                        this.initSocket();
                    }
                }, 5000);
                
                // Send periodic ping
                setInterval(() => {
                    if (this.socket && this.socket.connected) {
                        this.socket.emit('ping', { 
                            timestamp: Date.now(),
                            wantsToBeMaster: this.wantsToBeMaster
                        });
                    }
                }, 30000);
                
                // Refresh master list setiap 10 detik
                setInterval(() => {
                    if (this.socket && this.socket.connected) {
                        this.refreshMasterList();
                    }
                }, 10000);
                
                // Sync master status setiap 5 detik
                setInterval(() => {
                    if (this.socket && this.socket.connected && this.clientId) {
                        this.syncMasterStatus();
                    }
                }, 5000);

                this.intervalsInitialized = true;
            }
            
            // Save state before page unload
            window.addEventListener('beforeunload', () => {
                this.saveAudioState();
                this.saveMasterPreference();
                this.saveClientId();
            });
            
            // Initialize socket connection
            this.initSocket();
        },
        
        // Load client ID from localStorage
        loadClientId() {
            try {
                const saved = localStorage.getItem('ttsClientId');
                if (saved) {
                    this.savedClientId = saved;
                    // console.log('Loaded saved client ID:', saved.substring(0, 8));
                }
            } catch (error) {
                console.error('Failed to load client ID:', error);
            }
        },
        
        // Save client ID to localStorage
        saveClientId() {
            if (this.clientId) {
                localStorage.setItem('ttsClientId', this.clientId);
                this.savedClientId = this.clientId;
            }
        },
        
        // Sync master status with server
        async syncMasterStatus() {
            if (!this.clientId) return;
            
            try {
                const response = await fetch(`/api/client-status/${this.clientId}`);
                const data = await response.json();
                
                if (data.success && data.exists) {
                    if (data.isMaster && !this.isMaster) {
                        // Server says we're master but local state doesn't match
                        // console.log('Syncing master status: server says we are master');
                        this.isMaster = true;
                        this.wasMasterBeforeDisconnect = true;
                        localStorage.setItem('ttsWasMaster', 'true');
                        this.showNotification('Status Master disinkronkan dengan server', 'info');
                    } else if (!data.isMaster && this.isMaster) {
                        // Server says we're not master but local state says we are
                        // console.log('Syncing master status: server says we are NOT master');
                        this.isMaster = false;
                        this.showNotification('Status Master diperbarui dari server', 'warning');
                    }
                }
            } catch (error) {
                console.error('Failed to sync master status:', error);
            }
        },
        
        // Initialize Socket.io connection
        initSocket() {
            // Close existing connection
            if (this.socket) {
                this.socket.disconnect();
            }
            
            // Get reconnection flag from URL or localStorage
            const reconnected = localStorage.getItem('ttsReconnecting') === 'true';
            if (reconnected) {
                this.wasMasterBeforeDisconnect = localStorage.getItem('ttsWasMaster') === 'true';
                // console.log('Reconnecting, was master before:', this.wasMasterBeforeDisconnect);
            }
            
            // Create new connection
            this.socket = io({
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                timeout: 20000,
                forceNew: true
            });
            
            // Socket event listeners
            this.socket.on('connect', () => {
                this.serverStatus = 'connected';
                this.serverStatusText = 'Terhubung ke server';
                this.reconnectAttempts = 0;
                
                // Clear reconnection flag
                localStorage.removeItem('ttsReconnecting');
                
                // Send client info with reconnection flag
                this.socket.emit('client-info', {
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    screen: `${window.screen.width}x${window.screen.height}`,
                    url: window.location.href,
                    wantsToBeMaster: this.wantsToBeMaster,
                    reconnected: reconnected,
                    wasMaster: this.wasMasterBeforeDisconnect,
                    savedClientId: this.savedClientId
                });
                
                // Show notification
                if (reconnected) {
                    if (this.wasMasterBeforeDisconnect) {
                        this.showNotification('Mencoba kembali sebagai Master...', 'info');
                    } else {
                        this.showNotification('Berhasil menyambung kembali ke server', 'success');
                    }
                }
                
                // Request master list
                this.refreshMasterList();
                
                // Sync master status after a delay
                setTimeout(() => {
                    if (this.clientId) {
                        this.syncMasterStatus();
                    }
                }, 1500);
            });
            
            this.socket.on('welcome', (data) => {
                this.clientId = data.clientId;
                this.clientIdShort = data.clientId.substring(0, 8);
                this.saveClientId();
                
                this.showNotification('Terhubung ke server TTS Multi-Master', 'success');
                
                // If we were master before disconnect, request master role
                if (this.wasMasterBeforeDisconnect && !this.isMaster) {
                    setTimeout(() => {
                        if (!this.isMaster && this.wantsToBeMaster) {
                            // console.log('Auto-requesting master role after reconnect');
                            this.requestMasterRole(true);
                        }
                    }, 2000);
                }
            });
            
            this.socket.on('connection-status', (data) => {
                this.clientId = data.clientId;
                this.clientIdShort = data.clientId.substring(0, 8);
                this.isMaster = data.isMaster;
                this.masterClients = data.masterList || [];
                this.connectedClients = data.connectedClients || [];
                
                // Update wasMaster state if we are master
                if (this.isMaster) {
                    this.wasMasterBeforeDisconnect = true;
                    localStorage.setItem('ttsWasMaster', 'true');
                }
                
                // Auto-request master role only if no masters and we want to be master
                if (this.wantsToBeMaster && 
                    !this.isMaster && 
                    this.masterClients.length === 0 && 
                    this.reconnectAttempts < this.maxReconnectAttempts) {
                    
                    setTimeout(() => {
                        if (this.wantsToBeMaster && !this.isMaster && this.masterClients.length === 0) {
                            this.reconnectAttempts++;
                            this.requestMasterRole(true);
                        }
                    }, 1500);
                } else if (this.masterClients.length > 0 && this.wantsToBeMaster && !this.isMaster) {
                    // In multi-master mode, we can still request to be master
                    if (this.wasMasterBeforeDisconnect) {
                        setTimeout(() => {
                            if (this.wasMasterBeforeDisconnect && !this.isMaster) {
                                // console.log('Re-requesting master role in multi-master mode');
                                this.requestMasterRole(true);
                            }
                        }, 2500);
                    }
                }
                
                // Jika sebelumnya master dan sekarang bukan master
                if (this.wasMasterBeforeDisconnect && !this.isMaster && this.masterClients.length > 0) {
                    this.showNotification(
                        'Mencoba kembali menjadi Master...',
                        'info'
                    );
                }
            });
            
            this.socket.on('client-connected', (data) => {
                this.connectedClients = data.connectedClients || [];
                this.showNotification(`Komputer baru terhubung: ${this.shortClientId(data.clientId)}`, 'info');
            });
            
            this.socket.on('client-disconnected', (data) => {
                this.connectedClients = data.connectedClients || [];
                this.showNotification(`Komputer terputus: ${this.shortClientId(data.clientId)}`, 'warning');
            });
            
            this.socket.on('master-added', (data) => {
                this.updateMasterList(data.masterList || []);
                
                const addedMaster = data.masterClientId;
                if (this.clientId === addedMaster) {
                    this.isMaster = true;
                    this.wasMasterBeforeDisconnect = true;
                    localStorage.setItem('ttsWasMaster', 'true');
                    
                    if (data.reason === 'auto-reconnect-was-master' || data.reason === 'auto-reconnect-no-masters') {
                        this.showNotification('Anda kembali sebagai Master Controller!', 'success');
                    } else {
                        this.showNotification('Anda sekarang adalah Master Controller!', 'success');
                    }
                } else {
                    this.showNotification(`${this.shortClientId(addedMaster)} ditambahkan sebagai Master`, 'info');
                }
            });
            
            this.socket.on('master-removed', (data) => {
                this.updateMasterList(data.masterList || []);
                
                const removedMaster = data.removedMasterId;
                if (this.clientId === removedMaster) {
                    this.isMaster = false;
                    this.showNotification('Anda dikeluarkan dari Master Controller', 'warning');
                    // Don't clear wasMaster flag - we might want to reconnect as master
                } else {
                    this.showNotification(`${this.shortClientId(removedMaster)} dikeluarkan dari Master`, 'info');
                }
            });
            
            this.socket.on('master-role-granted', (data) => {
                this.isMaster = true;
                this.isRequestingMaster = false;
                this.wantsToBeMaster = true;
                this.wasMasterBeforeDisconnect = true;
                this.saveMasterPreference();
                this.reconnectAttempts = 0;
                
                localStorage.setItem('ttsWasMaster', 'true');
                
                if (data.autoReconnected) {
                    if (data.wasMaster) {
                        this.showNotification('Anda berhasil kembali sebagai Master Controller!', 'success');
                    } else {
                        this.showNotification('Anda menjadi Master Controller!', 'success');
                    }
                } else {
                    this.showNotification(data.message || 'Anda sekarang adalah Master Controller!', 'success');
                }
                
                // Update master list
                this.refreshMasterList();
            });
            
            this.socket.on('master-role-denied', (data) => {
                this.isRequestingMaster = false;
                this.showNotification(`Gagal menjadi Master: ${data.reason}`, 'error');
                
                if (this.wantsToBeMaster) {
                    this.saveMasterPreference();
                }
            });
            
            this.socket.on('master-role-released', (data) => {
                this.isMaster = false;
                this.wasMasterBeforeDisconnect = false;
                
                if (data.preferenceCleared) {
                    this.wantsToBeMaster = false;
                    this.saveMasterPreference();
                    localStorage.removeItem('ttsWasMaster');
                } else {
                    // Keep wasMaster flag if preference not cleared
                    localStorage.setItem('ttsWasMaster', 'false');
                }
                
                this.showNotification(data.message || 'Anda telah melepaskan peran Master', 'info');
                
                // Update master list
                this.refreshMasterList();
            });
            
            this.socket.on('master-disconnected', (data) => {
                this.updateMasterList(data.masterList || []);
                
                if (data.wantsToBeMaster) {
                    this.showNotification(`Master Controller terputus: ${this.shortClientId(data.disconnectedMasterId)} (ingin kembali sebagai Master)`, 'warning');
                } else {
                    this.showNotification(`Master Controller terputus: ${this.shortClientId(data.disconnectedMasterId)}`, 'warning');
                }
            });
            
            this.socket.on('master-needed', (data) => {
                if (!this.isMaster && this.wantsToBeMaster) {
                    this.showNotification(`Master diperlukan! ${data.pendingRequests} permintaan dalam antrian.`, 'warning');
                    if (this.autoRequestMaster) {
                        setTimeout(() => {
                            if (!this.isMaster) {
                                this.requestMasterRole();
                            }
                        }, 2000);
                    }
                }
            });
            
            this.socket.on('master-list-response', (data) => {
                this.updateMasterList(data.masterList || []);
            });
            
            this.socket.on('master-list-updated', (data) => {
                this.updateMasterList(data.masterList || []);
            });
            
            this.socket.on('tts-audio', (data) => {
                // Hanya Master yang memproses audio ini
                if (this.isMaster) {
                    // Store the audio data
                    this.currentAudio = data;
                    this.saveAudioState();
                    
                    // Pastikan audio memiliki URL
                    if (!data.audioUrl) {
                        console.error('Audio URL tidak ditemukan di data:', data);
                        this.showNotification('Error: Audio tidak valid', 'error');
                        return;
                    }
                    
                    // Tampilkan notifikasi
                    this.showNotification(`Menerima audio dari ${data.fromClientId?.substring(0, 8) || 'unknown'}`, 'info');
                    
                    // Tunggu sebentar untuk memastikan audio URL tersedia di DOM
                    setTimeout(() => {
                        this.playAudio();
                    }, 300);
                } else {
                    // Client biasa hanya menampilkan notifikasi
                    this.showNotification(
                        `Teks telah dikirim ke ${data.masterCount || 1} Master`,
                        'info'
                    );
                }
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
                    masterCount: data.masterCount || 1,
                    message: data.message
                });
                
                this.showNotification(data.message || 'TTS berhasil dikirim', 'success');
                
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
                if (data.fromMaster) {
                    // Master mengirim perintah play
                    this.showNotification(`Master ${data.issuedBy?.substring(0, 8) || ''} memutar audio`, 'info');
                    if (this.currentAudio) {
                        this.playAudio();
                    }
                }
            });
            
            this.socket.on('stop-audio-command', (data) => {
                if (data.fromMaster) {
                    this.stopAudio();
                    this.showNotification(`Master ${data.issuedBy?.substring(0, 8) || ''} menghentikan audio`, 'info');
                }
            });
            
            this.socket.on('tts-notification', (data) => {
                if (data.fromClientId !== this.clientId) {
                    this.showNotification(`${this.shortClientId(data.fromClientId)} mengirim teks ke semua master: "${data.textPreview}"`, 'info');
                }
            });
            
            this.socket.on('pong', (data) => {
                // Update status jika perlu
            });
            
            this.socket.on('disconnect', (reason) => {
                this.serverStatus = 'disconnected';
                this.serverStatusText = 'Terputus dari server';
                
                // Set reconnection flag
                localStorage.setItem('ttsReconnecting', 'true');
                
                // Save current state
                this.saveAudioState();
                this.saveMasterPreference();
                this.saveClientId();
                
                if (this.isMaster) {
                    this.showNotification('Anda terputus dari server. Mencoba menyambung kembali sebagai Master...', 'warning');
                } else {
                    this.showNotification('Terputus dari server. Mencoba menyambung ulang...', 'warning');
                }
            });
            
            this.socket.on('connect_error', (error) => {
                console.error('Connection error:', error);
                this.serverStatus = 'error';
                this.serverStatusText = 'Gagal menyambung ke server';
                this.showNotification(`Koneksi gagal: ${error.message}`, 'error');
            });
            
            this.socket.on('error', (error) => {
                console.error('Socket error:', error);
                this.showNotification('Kesalahan koneksi socket', 'error');
            });
        },
        
        // Update master list
        updateMasterList(masterList) {
            this.masterClients = masterList.map(master => ({
                id: master.id,
                socketId: master.socketId,
                shortId: master.id ? master.id.substring(0, 8) : 'unknown'
            }));
            
            // Jika kita adalah master, periksa apakah kita ada di daftar
            if (this.isMaster) {
                const isStillMaster = this.masterClients.some(m => m.id === this.clientId);
                if (!isStillMaster) {
                    this.isMaster = false;
                    this.showNotification('Anda telah dikeluarkan dari daftar master', 'warning');
                }
            }
        },
        
        // Refresh master list
        refreshMasterList() {
            if (this.socket && this.socket.connected) {
                this.socket.emit('get-master-list');
            }
        },
        
        // Save master preference to localStorage
        saveMasterPreference() {
            const preference = {
                wantsToBeMaster: this.wantsToBeMaster,
                autoRequestMaster: this.autoRequestMaster,
                savedAt: new Date().toISOString(),
                clientId: this.clientId,
                wasMaster: this.wasMasterBeforeDisconnect
            };
            localStorage.setItem('ttsMasterPreference', JSON.stringify(preference));
        },
        
        // Load master preference from localStorage
        loadMasterPreference() {
            try {
                const saved = localStorage.getItem('ttsMasterPreference');
                if (saved) {
                    const preference = JSON.parse(saved);
                    this.wantsToBeMaster = preference.wantsToBeMaster || false;
                    this.autoRequestMaster = preference.autoRequestMaster !== false;
                    this.wasMasterBeforeDisconnect = preference.wasMaster || false;
                }
            } catch (error) {
                console.error('Failed to load master preference:', error);
                this.wantsToBeMaster = false;
                this.autoRequestMaster = true;
                this.wasMasterBeforeDisconnect = false;
            }
        },
        
        // Clear master preference
        clearMasterPreference() {
            localStorage.removeItem('ttsMasterPreference');
            localStorage.removeItem('ttsWasMaster');
            this.wantsToBeMaster = false;
            this.autoRequestMaster = true;
            this.wasMasterBeforeDisconnect = false;
        },
        
        // Save audio state to localStorage
        saveAudioState() {
            const audioState = {
                currentAudio: this.currentAudio,
                isPlaying: this.isPlaying,
                timestamp: new Date().toISOString(),
                clientId: this.clientId
            };
            localStorage.setItem('ttsAudioState', JSON.stringify(audioState));
        },
        
        // Load audio state from localStorage
        loadAudioState() {
            try {
                const saved = localStorage.getItem('ttsAudioState');
                if (saved) {
                    const audioState = JSON.parse(saved);
                    
                    const savedTime = new Date(audioState.timestamp);
                    const now = new Date();
                    const diffMinutes = (now - savedTime) / (1000 * 60);
                    
                    if (diffMinutes < 10 && audioState.currentAudio) {
                        this.currentAudio = audioState.currentAudio;
                    }
                }
            } catch (error) {
                console.error('Failed to load audio state:', error);
            }
        },
        
        // Clear audio state
        clearAudioState() {
            localStorage.removeItem('ttsAudioState');
        },
        
        // Request master role
        requestMasterRole(autoReconnect = false) {
            if (this.isMaster || !this.socket || !this.socket.connected) return;
            
            this.isRequestingMaster = true;
            this.wantsToBeMaster = true;
            this.wasMasterBeforeDisconnect = true;
            this.saveMasterPreference();
            
            this.socket.emit('request-master-role', {
                timestamp: new Date().toISOString(),
                clientId: this.clientId,
                wantsToBeMaster: true,
                autoReconnect: autoReconnect,
                wasMaster: this.wasMasterBeforeDisconnect
            });
            
            if (autoReconnect) {
                this.showNotification('Mencoba kembali menjadi Master...', 'info');
            } else {
                this.showNotification('Mengirim permintaan menjadi Master...', 'info');
            }
        },
        
        // Release master role
        releaseMasterRole(clearPreference = false) {
            if (!this.isMaster || !this.socket || !this.socket.connected) return;
            
            this.socket.emit('release-master-role', {
                clearPreference: clearPreference,
                timestamp: new Date().toISOString()
            });
            
            this.isMaster = false;
            
            if (clearPreference) {
                this.wantsToBeMaster = false;
                this.wasMasterBeforeDisconnect = false;
                this.clearMasterPreference();
            } else {
                this.wasMasterBeforeDisconnect = true;
                localStorage.setItem('ttsWasMaster', 'false');
            }
        },
        
        // Convert text to speech (hanya ke semua master)
        async convertToSpeech() {
            const trimmedText = this.text ? this.text.trim() : '';

            if (!trimmedText) {
                this.showNotification('Silakan masukkan teks terlebih dahulu', 'error');
                return;
            }
            
            if (this.text.length > 5000) {
                this.showNotification(`Teks terlalu panjang. Maksimal 5000 karakter. Saat ini: ${this.text.length}`, 'error');
                return;
            }
            
            if (!this.socket || !this.socket.connected) {
                this.showNotification('Tidak terhubung ke server. Coba sambungkan ulang.', 'error');
                return;
            }
            
            this.isLoading = true;
            
            try {
                const requestData = {
                    text: trimmedText,
                    language: this.language,
                    speed: Math.max(0.5, Math.min(parseFloat(this.speed) || 1.0, 2.0)),
                    priority: this.priority,
                    timestamp: new Date().toISOString()
                };
                
                this.socket.emit('tts-request', requestData);
                this.showNotification('Mengirim teks ke semua Master...', 'info');
                
            } catch (error) {
                this.isLoading = false;
                this.showNotification(`Gagal mengirim: ${error.message}`, 'error');
                console.error('TTS Error:', error);
            }
        },
        
        // Play audio
        playAudio(retryCount = 0) {
            if (retryCount >= this.maxPlayRetries) {
                console.error('Max retry attempts reached');
                this.showNotification('Gagal memutar audio setelah beberapa percobaan', 'error');
                return;
            }
            
            if (!this.currentAudio || !this.currentAudio.audioUrl) {
                this.showNotification('Tidak ada audio untuk diputar', 'error');
                console.error('No audio to play');
                return;
            }
            
            let audioElement;
            if (this.isMaster) {
                audioElement = document.getElementById('masterAudioPlayer');
            } else {
                audioElement = document.getElementById('hiddenAudio');
            }
            
            if (!audioElement) {
                console.error('Audio element tidak ditemukan');
                
                if (this.isMaster) {
                    let player = document.createElement('audio');
                    player.id = 'masterAudioPlayer';
                    player.controls = true;
                    player.className = 'w-full rounded-lg';
                    player.autoplay = true;
                    player.playsInline = true;
                    player.preload = 'auto';
                    document.body.appendChild(player);
                    audioElement = player;
                } else {
                    let hidden = document.createElement('audio');
                    hidden.id = 'hiddenAudio';
                    hidden.className = 'hidden';
                    hidden.autoplay = true;
                    hidden.playsInline = true;
                    hidden.preload = 'auto';
                    document.body.appendChild(hidden);
                    audioElement = hidden;
                }
            }
            
            audioElement.src = this.currentAudio.audioUrl;
            audioElement.load();
            
            audioElement.onplay = () => {
                this.isPlaying = true;
            };
            
            audioElement.onpause = () => {
                this.isPlaying = false;
            };
            
            audioElement.onended = () => {
                this.isPlaying = false;
                this.showNotification('Audio selesai diputar', 'info');
            };
            
            const playPromise = audioElement.play();
            
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    this.isPlaying = true;
                    
                    if (this.socket && this.socket.connected) {
                        this.socket.emit('audio-status', 'playing');
                    }
                    
                    this.showNotification('Memutar audio...', 'success');
                    
                }).catch(error => {
                    console.error(`Play error (attempt ${retryCount + 1}):`, error);
                    
                    if (error.name === 'NotAllowedError') {
                        this.tryMutedAutoplay(audioElement, retryCount);
                    } else if (error.name === 'AbortError' || error.name === 'NetworkError') {
                        if (retryCount < this.maxPlayRetries - 1) {
                            setTimeout(() => {
                                this.playAudio(retryCount + 1);
                            }, 500 * (retryCount + 1));
                        }
                    } else {
                        this.showNotification('Gagal memutar audio', 'error');
                    }
                });
            }
        },

        // Fallback autoplay untuk browser yang blokir autoplay dengan suara
        tryMutedAutoplay(audioElement, retryCount = 0) {
            if (!audioElement) return;

            const previousMuted = audioElement.muted;
            const previousVolume = audioElement.volume;

            audioElement.muted = true;
            audioElement.volume = 0;

            const mutedPlayPromise = audioElement.play();
            if (mutedPlayPromise !== undefined) {
                mutedPlayPromise.then(() => {
                    // Setelah playback dimulai dalam mode muted, aktifkan kembali suara
                    setTimeout(() => {
                        audioElement.muted = previousMuted;
                        audioElement.volume = previousVolume || 1;
                    }, 120);

                    this.isPlaying = true;
                    if (this.socket && this.socket.connected) {
                        this.socket.emit('audio-status', 'playing');
                    }
                    this.showNotification('Audio diputar otomatis', 'success');
                }).catch((mutedError) => {
                    console.error(`Muted autoplay failed (attempt ${retryCount + 1}):`, mutedError);

                    audioElement.muted = previousMuted;
                    audioElement.volume = previousVolume || 1;

                    this.showNotification(
                        'Browser memblokir autoplay. Klik tombol play sekali untuk aktivasi.',
                        'warning',
                        true
                    );
                    
                    if (this.isMaster && audioElement) {
                        audioElement.style.border = '3px solid #f59e0b';
                        audioElement.style.boxShadow = '0 0 15px rgba(245, 158, 11, 0.7)';
                    }
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
                if (this.socket && this.socket.connected) {
                    this.socket.emit('audio-status', 'paused');
                }
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
                if (this.socket && this.socket.connected) {
                    this.socket.emit('audio-status', 'stopped');
                }
                
                if (this.isMaster && this.socket && this.socket.connected) {
                    this.socket.emit('stop-audio');
                }
            }
        },
        
        // Audio event handlers
        onAudioPlay() {
            this.isPlaying = true;
            this.saveAudioState();
        },
        
        onAudioPause() {
            this.isPlaying = false;
            this.saveAudioState();
        },
        
        onAudioEnd() {
            this.isPlaying = false;
            this.saveAudioState();
            this.showNotification('Audio selesai diputar', 'info');
        },
        
        // Download audio
        downloadAudio() {
            if (!this.currentAudio || !this.currentAudio.audioUrl) return;
            
            const link = document.createElement('a');
            link.href = this.currentAudio.audioUrl;
            const filename = `tts-${this.currentAudio.fromClientId || 'audio'}-${Date.now()}.mp3`;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            this.showNotification('Audio berhasil diunduh', 'success');
        },
        
        // Share audio info
        shareAudio() {
            if (!this.currentAudio) return;
            
            const shareText = `TTS dari ${this.currentAudio.fromClientId || 'unknown'}: ${this.text.substring(0, 50)}...`;
            
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
            this.clearAudioState();
        },
        
        // Show notification
        showNotification(message, type = 'info', important = false) {
            const notification = {
                id: Date.now() + Math.random(),
                message: message,
                type: type,
                important: important,
                timestamp: new Date().toISOString()
            };
            
            this.notifications.push(notification);
            
            setTimeout(() => {
                this.removeNotification(notification.id);
            }, important ? 10000 : 5000);
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
            return `Kirim ke ${this.masterClients.length} Master`;
        },
        
        // Toggle Mobile Menu
        toggleMobileMenu() {
            this.showMobileMenu = !this.showMobileMenu;
        },
        
        // Close Mobile Menu
        closeMobileMenu() {
            this.showMobileMenu = false;
        },
        
        // Helper methods
        shortClientId(clientId) {
            return typeof clientId === 'string' && clientId.length > 0
                ? clientId.substring(0, 8)
                : 'unknown';
        },

        updateCharCount() {
            if (!this.text) {
                this.charCount = 0;
                this.wordCount = 0;
                return;
            }
            
            this.charCount = this.text.length;
            const trimmed = this.text.trim();
            this.wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
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
                "Halo, selamat datang di sistem TTS Multi-Master.",
                "Audio dapat dikirim ke semua master yang aktif.",
                "Silakan masukkan teks Anda di sini untuk dikonversi menjadi suara.",
                "Sistem ini mendukung multiple master controller."
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
        
        toggleMasterPreference() {
            this.showMasterPreferenceModal = !this.showMasterPreferenceModal;
        },
        
        toggleMasterList() {
            this.showMasterListModal = !this.showMasterListModal;
            if (this.showMasterListModal) {
                this.refreshMasterList();
            }
        },
        
        // Get master status badge
        get masterStatusBadge() {
            if (this.isMaster) {
                return 'Master Aktif';
            } else if (this.wantsToBeMaster) {
                return 'Menunggu Master';
            } else {
                return 'Client Biasa';
            }
        },
        
        // Get master status color
        get masterStatusColor() {
            if (this.isMaster) {
                return 'success';
            } else if (this.wantsToBeMaster) {
                return 'warning';
            } else {
                return 'secondary';
            }
        }
    };
}
