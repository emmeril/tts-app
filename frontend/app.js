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

        // Scheduler alarm mingguan khusus file audio upload
        schedules: [],
        showSchedulerModal: false,
        schedulerDraft: null,
        schedulerTimer: null,
        runningScheduleIds: [],
        schedulerItemWaiters: {},
        schedulerRunStates: {},
        maxScheduleAudioSizeMb: 20,
        scheduleDayOptions: [
            { value: 1, label: 'Senin', shortLabel: 'Sen' },
            { value: 2, label: 'Selasa', shortLabel: 'Sel' },
            { value: 3, label: 'Rabu', shortLabel: 'Rab' },
            { value: 4, label: 'Kamis', shortLabel: 'Kam' },
            { value: 5, label: 'Jumat', shortLabel: 'Jum' },
            { value: 6, label: 'Sabtu', shortLabel: 'Sab' },
            { value: 0, label: 'Minggu', shortLabel: 'Min' }
        ],

        // Voice note recorder
        voiceRecorder: null,
        voiceStream: null,
        voiceChunks: [],
        voiceNoteBlob: null,
        voiceNoteUrl: '',
        voiceNoteDuration: 0,
        voiceNoteMimeType: '',
        voiceRecordingStartedAt: 0,
        voiceRecordingSeconds: 0,
        voiceRecordingTimer: null,
        voiceDiscardOnStop: false,
        isRecordingVoice: false,
        isSendingVoice: false,
        maxVoiceNoteSeconds: 300,
        
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
        audioPrimed: false,
        audioUnlockListenersAttached: false,
        pendingAutoplayAudio: false,
        lastHandledRequestId: null,
        silentWavDataUri: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=',
        
        // Initialize
        init() {
            this.updateCharCount();
            this.loadLanguages();
            this.loadHistory();
            this.loadMasterPreference();
            this.loadAudioState();
            this.loadSchedules();
            this.startScheduler();
            this.loadClientId();
            this.setupAudioAutoplayBootstrap();

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
                this.stopScheduler();
                this.releaseVoiceRecorder();
                this.revokeVoiceNoteUrl();
            });
            
            // Initialize socket connection
            this.initSocket();
        },

        setupAudioAutoplayBootstrap() {
            const audioElement = this.getOrCreateAudioElement();
            if (!audioElement) return;

            audioElement.autoplay = true;
            audioElement.loop = false;
            audioElement.playsInline = true;
            audioElement.preload = 'auto';

            if (!this.audioUnlockListenersAttached) {
                this.audioUnlockListenersAttached = true;

                const unlock = () => {
                    this.audioPrimed = true;

                    if (this.pendingAutoplayAudio && this.currentAudio?.audioUrl) {
                        this.pendingAutoplayAudio = false;
                        this.playAudio();
                    }
                };

                window.addEventListener('pointerdown', unlock, { once: true, passive: true });
                window.addEventListener('touchstart', unlock, { once: true, passive: true });
                window.addEventListener('keydown', unlock, { once: true });
            }

            this.primeAudioElement(audioElement);
        },

        async fetchJsonOrThrow(url, fallbackError) {
            const response = await fetch(url);
            const data = await response.json().catch(() => ({}));

            if (!response.ok || data.success === false) {
                const error = new Error(data.error || data.message || fallbackError || `Request gagal (${response.status})`);
                error.status = response.status;
                error.payload = data;
                throw error;
            }

            return data;
        },

        getEventErrorMessage(data, fallbackMessage) {
            return data?.error || data?.reason || data?.message || fallbackMessage;
        },

        primeAudioElement(audioElement) {
            if (!audioElement || this.audioPrimed) return;

            const prevMuted = audioElement.muted;
            const prevVolume = audioElement.volume;
            const prevSrc = audioElement.src;

            audioElement.muted = true;
            audioElement.volume = 0;
            audioElement.src = this.silentWavDataUri;

            const primePromise = audioElement.play();
            if (primePromise !== undefined) {
                primePromise.then(() => {
                    audioElement.pause();
                    audioElement.currentTime = 0;
                    this.audioPrimed = true;
                }).catch(() => {
                    // Tetap lanjut; beberapa browser butuh user gesture pertama.
                }).finally(() => {
                    audioElement.muted = prevMuted;
                    audioElement.volume = prevVolume;

                    if (prevSrc && prevSrc !== this.silentWavDataUri) {
                        audioElement.src = prevSrc;
                    } else {
                        audioElement.removeAttribute('src');
                    }
                    audioElement.load();
                });
            }
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
                const data = await this.fetchJsonOrThrow(
                    `/api/client-status/${this.clientId}`,
                    'Gagal menyinkronkan status master'
                );
                
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
                this.showNotification(`Gagal menjadi Master: ${this.getEventErrorMessage(data, 'Permintaan ditolak')}`, 'error');
                
                if (this.wantsToBeMaster) {
                    this.saveMasterPreference();
                }
            });

            this.socket.on('master-role-duplicate', (data) => {
                this.isRequestingMaster = false;
                this.showNotification(this.getEventErrorMessage(data, 'Anda sudah menjadi Master Controller'), 'info');
            });

            this.socket.on('auth-error', (data) => {
                this.serverStatus = 'error';
                this.serverStatusText = 'Token socket tidak valid';
                this.showNotification(this.getEventErrorMessage(data, 'Token socket tidak valid'), 'error', true);
            });
            
            this.socket.on('master-role-released', (data) => {
                this.isMaster = false;
                this.wasMasterBeforeDisconnect = false;
                
                if (data.preferenceCleared) {
                    this.wantsToBeMaster = false;
                    this.saveMasterPreference();
                    localStorage.removeItem('ttsWasMaster');
                } else {
                    // Preference tetap aktif, tetapi role master tidak dipulihkan otomatis.
                    this.saveMasterPreference();
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

            this.socket.on('master-inactive', (data) => {
                this.updateMasterList((this.masterClients || []).filter(master => master.id !== data.inactiveClientId));
                this.showNotification(`Master tidak aktif: ${this.shortClientId(data.inactiveClientId)}`, 'warning');
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
                    if (data.requestId && data.requestId === this.lastHandledRequestId) {
                        console.warn('Duplicate tts-audio ignored:', data.requestId);
                        return;
                    }

                    if (this.currentAudio?.requestId && this.currentAudio.requestId !== data.requestId && this.isPlaying) {
                        this.emitAudioPlaybackStatus('interrupted', this.currentAudio);
                    }

                    this.lastHandledRequestId = data.requestId || null;

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
                    const incomingLabel = data.sourceType === 'voice-note' ? 'Voice note' : 'Audio';
                    this.showNotification(`Menerima ${incomingLabel} dari ${data.fromClientId?.substring(0, 8) || 'unknown'}`, 'info');
                    
                    // Tunggu sebentar untuk memastikan audio URL tersedia di DOM
                    const requestId = data.requestId || null;
                    setTimeout(() => {
                        // Ignore a delayed callback if a newer request replaced this audio.
                        if (!this.socket?.connected) return;
                        if (this.currentAudio !== data && this.currentAudio?.requestId !== requestId) return;
                        this.playAudio(0, requestId || null);
                    }, 300);
                } else {
                    // Client biasa hanya menampilkan notifikasi
                    const sentLabel = data.sourceType === 'voice-note' ? 'Voice note' : 'Teks';
                    this.showNotification(`${sentLabel} telah dikirim ke ${data.masterCount || 1} Master`, 'info');
                }
            });
            
            this.socket.on('tts-complete', (data) => {
                this.isLoading = false;

                // Request dari scheduler tidak boleh mengosongkan teks yang
                // sedang diketik user atau tercatat memakai state form utama.
                if (data.schedulerId) {
                    this.showNotification(`Item ${data.schedulerItem || ''} scheduler “${data.schedulerName || ''}” terkirim`, 'success');
                    return;
                }
                
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

                if (data.schedulerId) return;
                
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
                if (data.schedulerId) {
                    this.resolveScheduleItemWaiter({ ...data, status: 'error' });
                    this.showNotification(`Item ${data.schedulerItem || ''} scheduler gagal diproses`, 'error');
                    return;
                }
                this.showNotification(this.getEventErrorMessage(data, 'Terjadi kesalahan pada TTS'), 'error');
                
                this.addToHistory({
                    text: this.text,
                    language: this.language,
                    speed: this.speed,
                    success: false,
                    timestamp: new Date().toISOString(),
                    error: data.error
                });
            });

            this.socket.on('audio-complete', (data) => {
                if (data.schedulerId) {
                    this.showNotification(`Audio item ${data.schedulerItem || ''} scheduler “${data.schedulerName || ''}” terkirim`, 'success');
                    return;
                }
                if (this.isSendingVoice) {
                    this.isSendingVoice = false;
                    this.clearVoiceNote();
                }
                this.showNotification(data.message || 'Audio upload berhasil dikirim', 'success');
            });

            this.socket.on('audio-queued', (data) => {
                if (this.isSendingVoice) {
                    this.isSendingVoice = false;
                    this.clearVoiceNote();
                }
                this.showNotification(data.message || 'Audio upload masuk antrian', 'info');
            });

            this.socket.on('audio-error', (data) => {
                this.isSendingVoice = false;
                this.resolveScheduleItemWaiter({ ...data, status: 'error' });
                const itemLabel = data.schedulerItem ? `Item ${data.schedulerItem} scheduler: ` : '';
                this.showNotification(`${itemLabel}${this.getEventErrorMessage(data, 'Audio upload gagal diproses')}`, 'error');
            });

            this.socket.on('scheduler-item-finished', (data) => {
                this.resolveScheduleItemWaiter(data);
                if (data.status && data.status !== 'ended') {
                    this.showNotification(`Pemutaran audio item ${data.schedulerItem || ''} berhenti (${data.status}); scheduler dibatalkan`, 'warning');
                    this.cancelSchedulerRun(data.schedulerRunId, data.status);
                }
            });

            this.socket.on('play-audio-denied', (data) => {
                this.showNotification(this.getEventErrorMessage(data, 'Akses pemutaran audio ditolak'), 'warning');
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
                    this.stopAudio(false);
                    this.showNotification(`Master ${data.issuedBy?.substring(0, 8) || ''} menghentikan audio`, 'info');
                }
            });
            
            this.socket.on('tts-notification', (data) => {
                if (data.fromClientId !== this.clientId) {
                    this.showNotification(`${this.shortClientId(data.fromClientId)} mengirim teks ke semua master: "${data.textPreview}"`, 'info');
                }
            });

            this.socket.on('tts-request-cancelled', (data) => {
                this.showNotification(
                    this.getEventErrorMessage(data, 'Permintaan TTS dibatalkan'),
                    'warning'
                );
            });

            this.socket.on('queue-cleared', (data) => {
                this.showNotification(
                    data.clearedCount > 0
                        ? `Antrian TTS dibersihkan (${data.clearedCount} item)`
                        : 'Antrian TTS sudah kosong',
                    'info'
                );
            });
            
            this.socket.on('pong', (data) => {
                // Update status jika perlu
            });
            
            this.socket.on('disconnect', (reason) => {
                this.serverStatus = 'disconnected';
                this.serverStatusText = 'Terputus dari server';
                this.isSendingVoice = false;
                this.cancelSchedulerRuns(`connection-${reason || 'lost'}`);

                if (this.isMaster) {
                    this.stopAudio(false);
                    this.pendingAutoplayAudio = false;
                }
                
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
                this.wasMasterBeforeDisconnect = false;
                this.saveMasterPreference();
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

        getSupportedVoiceMimeType() {
            if (typeof MediaRecorder === 'undefined') return '';
            if (typeof MediaRecorder.isTypeSupported !== 'function') return '';

            const candidates = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/mp4',
                'audio/ogg;codecs=opus'
            ];

            return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
        },

        async startVoiceRecording() {
            if (this.isRecordingVoice || this.isSendingVoice) return;

            if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
                this.showNotification('Perekam langsung membutuhkan HTTPS atau localhost. Gunakan opsi rekam dari perangkat.', 'error');
                return;
            }

            try {
                this.clearVoiceNote();
                const mimeType = this.getSupportedVoiceMimeType();
                this.voiceStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });

                this.voiceChunks = [];
                this.voiceDiscardOnStop = false;
                this.voiceRecordingSeconds = 0;
                this.voiceRecordingStartedAt = Date.now();
                this.voiceNoteMimeType = mimeType;
                this.voiceRecorder = mimeType
                    ? new MediaRecorder(this.voiceStream, { mimeType })
                    : new MediaRecorder(this.voiceStream);

                this.voiceRecorder.ondataavailable = event => {
                    if (event.data?.size > 0) this.voiceChunks.push(event.data);
                };

                this.voiceRecorder.onerror = event => {
                    console.error('Voice recorder error:', event.error || event);
                    this.showNotification('Perekaman suara gagal. Coba izinkan akses mikrofon lagi.', 'error');
                    this.cancelVoiceRecording();
                };

                this.voiceRecorder.onstop = () => this.finishVoiceRecording();
                this.voiceRecorder.start(1000);
                this.isRecordingVoice = true;
                this.voiceRecordingTimer = setInterval(() => {
                    this.voiceRecordingSeconds = Math.min(
                        this.maxVoiceNoteSeconds,
                        Math.floor((Date.now() - this.voiceRecordingStartedAt) / 1000)
                    );

                    if (this.voiceRecordingSeconds >= this.maxVoiceNoteSeconds) {
                        this.stopVoiceRecording();
                        this.showNotification('Batas voice note 5 menit tercapai.', 'info');
                    }
                }, 250);
            } catch (error) {
                this.releaseVoiceRecorder();
                const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
                this.showNotification(
                    denied ? 'Akses mikrofon ditolak. Izinkan mikrofon dari pengaturan browser.' : `Mikrofon tidak dapat digunakan: ${error.message}`,
                    'error'
                );
            }
        },

        stopVoiceRecording() {
            if (!this.voiceRecorder || this.voiceRecorder.state === 'inactive') return;
            this.voiceRecorder.stop();
        },

        cancelVoiceRecording() {
            this.voiceDiscardOnStop = true;
            if (this.voiceRecorder && this.voiceRecorder.state !== 'inactive') {
                this.voiceRecorder.stop();
                return;
            }
            this.releaseVoiceRecorder();
            this.clearVoiceNote();
        },

        finishVoiceRecording() {
            const discard = this.voiceDiscardOnStop;
            const chunks = this.voiceChunks.slice();
            const mimeType = this.voiceRecorder?.mimeType || this.voiceNoteMimeType || chunks[0]?.type || 'audio/webm';
            const elapsed = Math.max(1, Math.round((Date.now() - this.voiceRecordingStartedAt) / 100) / 10);

            this.releaseVoiceRecorder();
            this.voiceChunks = [];
            this.voiceDiscardOnStop = false;
            if (discard) return;

            const blob = new Blob(chunks, { type: mimeType });
            const maxBytes = this.maxScheduleAudioSizeMb * 1024 * 1024;
            if (!blob.size) {
                this.showNotification('Voice note kosong. Silakan rekam ulang.', 'error');
                return;
            }
            if (blob.size > maxBytes) {
                this.showNotification(`Voice note terlalu besar. Maksimal ${this.maxScheduleAudioSizeMb} MB.`, 'error');
                return;
            }

            this.voiceNoteBlob = blob;
            this.voiceNoteMimeType = mimeType;
            this.voiceNoteDuration = Math.min(this.maxVoiceNoteSeconds, elapsed);
            this.voiceRecordingSeconds = Math.round(this.voiceNoteDuration);
            this.voiceNoteUrl = URL.createObjectURL(blob);
        },

        releaseVoiceRecorder() {
            if (this.voiceRecordingTimer) {
                clearInterval(this.voiceRecordingTimer);
                this.voiceRecordingTimer = null;
            }
            if (this.voiceStream) {
                this.voiceStream.getTracks().forEach(track => track.stop());
            }
            this.voiceStream = null;
            this.voiceRecorder = null;
            this.isRecordingVoice = false;
        },

        revokeVoiceNoteUrl() {
            if (this.voiceNoteUrl) URL.revokeObjectURL(this.voiceNoteUrl);
            this.voiceNoteUrl = '';
        },

        clearVoiceNote() {
            if (this.isRecordingVoice) {
                this.cancelVoiceRecording();
                return;
            }
            this.revokeVoiceNoteUrl();
            this.voiceNoteBlob = null;
            this.voiceNoteDuration = 0;
            this.voiceNoteMimeType = '';
            this.voiceRecordingSeconds = 0;
        },

        formatVoiceDuration(seconds) {
            const total = Math.max(0, Math.floor(Number(seconds) || 0));
            return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
        },

        getVoiceFileExtension(format) {
            return {
                'audio/webm': 'webm',
                'audio/mp4': 'm4a',
                'audio/ogg': 'ogg',
                'audio/mpeg': 'mp3',
                'audio/wav': 'wav'
            }[String(format || '').split(';')[0].toLowerCase()] || 'webm';
        },

        async selectVoiceNoteFile(event) {
            const input = event?.target;
            const file = input?.files?.[0];
            if (!file || this.isRecordingVoice || this.isSendingVoice) return;

            const format = this.getScheduleAudioType(file);
            const maxBytes = this.maxScheduleAudioSizeMb * 1024 * 1024;
            if (!format) {
                input.value = '';
                this.showNotification('Format rekaman tidak didukung. Gunakan WebM, M4A, MP3, WAV, atau OGG.', 'error');
                return;
            }
            if (file.size > maxBytes) {
                input.value = '';
                this.showNotification(`Voice note terlalu besar. Maksimal ${this.maxScheduleAudioSizeMb} MB.`, 'error');
                return;
            }

            this.clearVoiceNote();
            this.voiceNoteBlob = file;
            this.voiceNoteMimeType = format;
            this.voiceNoteDuration = await this.getLocalAudioDuration(file) || 1;
            this.voiceRecordingSeconds = Math.round(this.voiceNoteDuration);
            this.voiceNoteUrl = URL.createObjectURL(file);
            input.value = '';
        },

        async sendVoiceNote() {
            if (!this.voiceNoteBlob || this.isRecordingVoice || this.isSendingVoice) return;
            if (!this.socket?.connected) {
                this.showNotification('Tidak terhubung ke server. Coba sambungkan ulang.', 'error');
                return;
            }

            const format = this.getScheduleAudioType({
                type: this.voiceNoteBlob.type || this.voiceNoteMimeType,
                name: `voice-note.${this.getVoiceFileExtension(this.voiceNoteMimeType)}`
            });
            if (!format) {
                this.showNotification('Format voice note tidak didukung server.', 'error');
                return;
            }

            this.isSendingVoice = true;
            try {
                const now = new Date();
                const extension = this.getVoiceFileExtension(format);
                const fileName = `voice-note-${now.toISOString().replace(/[:.]/g, '-')}.${extension}`;
                const response = await fetch('/api/audio/upload', {
                    method: 'POST',
                    headers: {
                        'Content-Type': format,
                        'X-Audio-Name': encodeURIComponent(fileName)
                    },
                    body: this.voiceNoteBlob
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) {
                    throw new Error(data.error || data.message || `Upload gagal (${response.status})`);
                }

                this.socket.emit('audio-request', {
                    audioUrl: data.audioUrl,
                    fileName: `Voice note ${now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`,
                    audioSize: data.size || this.voiceNoteBlob.size,
                    duration: this.voiceNoteDuration,
                    format: data.format || format,
                    sourceType: 'voice-note',
                    priority: this.priority,
                    timestamp: now.toISOString()
                });
                this.showNotification('Mengirim voice note ke semua Master...', 'info');
            } catch (error) {
                this.isSendingVoice = false;
                this.showNotification(`Gagal mengirim voice note: ${error.message}`, 'error');
            }
        },
        
        // Play audio
        playAudio(retryCount = 0, expectedRequestId = null) {
            if (expectedRequestId && this.currentAudio?.requestId !== expectedRequestId) return;
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
            
            const audioElement = this.getOrCreateAudioElement();
            if (!audioElement) {
                console.error('Audio element tidak ditemukan');
                return;
            }

            audioElement.onplay = null;
            audioElement.onpause = null;
            audioElement.onended = null;
            audioElement.onerror = null;
            this.pendingAutoplayAudio = false;
            audioElement.pause();
            audioElement.currentTime = 0;
            
            audioElement.src = this.currentAudio.audioUrl;
            audioElement.loop = false;
            audioElement.load();

            const playbackAudio = this.currentAudio;
            const playbackRequestId = playbackAudio?.requestId || null;
            const isCurrentPlayback = () => (
                this.currentAudio === playbackAudio
                || (playbackRequestId && this.currentAudio?.requestId === playbackRequestId)
            );
            
            audioElement.onplay = () => {
                if (!isCurrentPlayback()) return;
                this.onAudioPlay();
            };
            
            audioElement.onpause = () => {
                if (!isCurrentPlayback()) return;
                this.onAudioPause();
            };
            
            audioElement.onended = () => {
                if (!isCurrentPlayback()) return;
                this.onAudioEnd();
            };

            audioElement.onerror = () => {
                if (!isCurrentPlayback()) return;
                this.onAudioError();
            };
            
            const playPromise = audioElement.play();
            
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    this.isPlaying = true;
                    
                    if (this.socket && this.socket.connected) {
                        this.emitAudioPlaybackStatus('playing');
                    }
                    
                    this.showNotification('Memutar audio...', 'success');
                    
                }).catch(error => {
                    console.error(`Play error (attempt ${retryCount + 1}):`, error);
                    
                    if (error.name === 'NotAllowedError') {
                        this.tryMutedAutoplay(audioElement, retryCount);
                    } else if (error.name === 'AbortError' || error.name === 'NetworkError') {
                        if (retryCount < this.maxPlayRetries - 1) {
                            setTimeout(() => {
                                if (!this.socket?.connected || !isCurrentPlayback()) return;
                                this.playAudio(retryCount + 1, playbackRequestId || this.currentAudio?.requestId);
                            }, 500 * (retryCount + 1));
                        }
                    } else {
                        this.showNotification('Gagal memutar audio', 'error');
                    }
                });
            }
        },

        getOrCreateAudioElement() {
            let audioElement;
            if (this.isMaster) {
                audioElement = document.getElementById('masterAudioPlayer');
            } else {
                audioElement = document.getElementById('hiddenAudio');
            }

            if (!audioElement) {
                if (this.isMaster) {
                    const player = document.createElement('audio');
                    player.id = 'masterAudioPlayer';
                    player.controls = true;
                    player.className = 'w-full rounded-lg';
                    player.autoplay = true;
                    player.loop = false;
                    player.playsInline = true;
                    player.preload = 'auto';
                    document.body.appendChild(player);
                    audioElement = player;
                } else {
                    const hidden = document.createElement('audio');
                    hidden.id = 'hiddenAudio';
                    hidden.className = 'hidden';
                    hidden.autoplay = true;
                    hidden.loop = false;
                    hidden.playsInline = true;
                    hidden.preload = 'auto';
                    document.body.appendChild(hidden);
                    audioElement = hidden;
                }
            }

            return audioElement;
        },

        // Fallback autoplay untuk browser yang blokir autoplay dengan suara
        tryMutedAutoplay(audioElement, retryCount = 0) {
            if (!audioElement) return;

            const playbackAudio = this.currentAudio;
            const playbackRequestId = playbackAudio?.requestId || null;
            const isCurrentPlayback = () => (
                this.currentAudio === playbackAudio
                || (playbackRequestId && this.currentAudio?.requestId === playbackRequestId)
            );

            const previousMuted = audioElement.muted;
            const previousVolume = audioElement.volume;

            audioElement.muted = true;
            audioElement.volume = 0;

            const mutedPlayPromise = audioElement.play();
            if (mutedPlayPromise !== undefined) {
                mutedPlayPromise.then(() => {
                    if (!isCurrentPlayback()) {
                        audioElement.muted = previousMuted;
                        audioElement.volume = previousVolume;
                        return;
                    }
                    // Setelah playback dimulai dalam mode muted, aktifkan kembali suara
                    setTimeout(() => {
                        if (!isCurrentPlayback()) return;
                        audioElement.muted = previousMuted;
                        audioElement.volume = previousVolume || 1;
                    }, 120);

                    this.isPlaying = true;
                    if (this.socket && this.socket.connected) {
                        this.emitAudioPlaybackStatus('playing');
                    }
                    this.showNotification('Audio diputar otomatis', 'success');
                }).catch((mutedError) => {
                    console.error(`Muted autoplay failed (attempt ${retryCount + 1}):`, mutedError);

                    audioElement.muted = previousMuted;
                    audioElement.volume = previousVolume || 1;
                    this.pendingAutoplayAudio = true;

                    this.showNotification(
                        'Browser memblokir autoplay awal. Audio akan diputar setelah interaksi pertama di halaman.',
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
                    this.emitAudioPlaybackStatus('paused');
                }
            }
        },
        
        // Stop audio
        stopAudio(notifyServer = true) {
            const audioElement = this.isMaster ? 
                document.getElementById('masterAudioPlayer') : 
                document.getElementById('hiddenAudio');
                
            if (audioElement) {
                audioElement.pause();
                audioElement.currentTime = 0;
                this.isPlaying = false;
                if (this.socket && this.socket.connected) {
                    this.emitAudioPlaybackStatus('stopped');
                }
                
                if (notifyServer && this.isMaster && this.socket && this.socket.connected) {
                    this.socket.emit('stop-audio');
                }
            }
        },
        
        // Audio event handlers
        emitAudioPlaybackStatus(status, audio = this.currentAudio) {
            if (!this.isMaster || !this.socket || !this.socket.connected) return;
            this.socket.emit('audio-status', {
                status,
                requestId: audio?.requestId || null,
                schedulerId: audio?.schedulerId || null,
                schedulerRunId: audio?.schedulerRunId || null,
                schedulerItem: audio?.schedulerItem || null
            });
        },

        onAudioPlay() {
            this.isPlaying = true;
            this.saveAudioState();
            this.emitAudioPlaybackStatus('playing');
        },
        
        onAudioPause() {
            this.isPlaying = false;
            this.saveAudioState();
            this.emitAudioPlaybackStatus('paused');
        },
        
        onAudioEnd() {
            this.isPlaying = false;
            this.saveAudioState();
            this.emitAudioPlaybackStatus('ended');
            this.showNotification('Audio selesai diputar', 'info');
        },

        onAudioError() {
            this.isPlaying = false;
            this.saveAudioState();
            this.emitAudioPlaybackStatus('error');
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
            const audioElement = this.getOrCreateAudioElement();
            if (audioElement) {
                audioElement.pause();
                audioElement.currentTime = 0;
                audioElement.removeAttribute('src');
                audioElement.load();
            }

            this.currentAudio = null;
            this.isPlaying = false;
            this.lastHandledRequestId = null;
            this.clearAudioState();
        },

        // ==================== Scheduler ====================
        newScheduleItem() {
            return {
                type: 'audio',
                priority: this.priority || 'normal',
                audioUrl: '',
                audioName: '',
                audioSize: 0,
                audioDuration: null,
                audioFormat: '',
                repeatCount: 1,
                repeatIntervalSeconds: 10,
                uploading: false
            };
        },

        openScheduler() {
            this.schedulerDraft = null;
            this.showSchedulerModal = true;
        },

        createSchedule() {
            this.schedulerDraft = {
                id: null,
                name: `Jadwal ${this.schedules.length + 1}`,
                time: '07:00',
                days: this.scheduleDayOptions.map(day => day.value),
                selectedDay: 'all',
                itemIntervalSeconds: 0,
                enabled: true,
                items: [this.newScheduleItem()]
            };
            this.showSchedulerModal = true;
        },

        editSchedule(schedule) {
            this.schedulerDraft = JSON.parse(JSON.stringify(schedule));
            const normalizedDays = this.normalizeScheduleDays(this.schedulerDraft.days);
            this.schedulerDraft.days = normalizedDays;
            this.schedulerDraft.selectedDay = normalizedDays.length === 7
                ? 'all'
                : String(normalizedDays[0] ?? 1);
            const audioItems = Array.isArray(this.schedulerDraft.items)
                ? this.schedulerDraft.items.filter(item => item?.audioUrl || item?.type === 'audio')
                : [];
            this.schedulerDraft.items = (audioItems.length ? audioItems : [this.newScheduleItem()]).map(item => ({
                ...this.newScheduleItem(),
                ...item,
                type: 'audio',
                repeatCount: Math.min(100, Math.max(1, Math.round(Number(item.repeatCount) || 1))),
                repeatIntervalSeconds: item.repeatIntervalSeconds === undefined
                    ? 10
                    : Math.min(3600, Math.max(0, Math.round(Number(item.repeatIntervalSeconds) || 0))),
                uploading: false
            }));
            this.showSchedulerModal = true;
        },

        normalizeScheduleDays(days, useAllAsDefault = true) {
            const validDays = new Set(this.scheduleDayOptions.map(day => day.value));
            const normalized = Array.isArray(days)
                ? [...new Set(days.map(Number).filter(day => validDays.has(day)))]
                : [];
            if (!normalized.length && useAllAsDefault) {
                return this.scheduleDayOptions.map(day => day.value);
            }
            return this.scheduleDayOptions
                .map(day => day.value)
                .filter(day => normalized.includes(day));
        },

        toggleDraftDay(day) {
            if (!this.schedulerDraft) return;
            const selectedDays = this.normalizeScheduleDays(this.schedulerDraft.days, false);
            this.schedulerDraft.days = selectedDays.includes(day)
                ? selectedDays.filter(value => value !== day)
                : this.normalizeScheduleDays([...selectedDays, day], false);
        },

        isDraftDaySelected(day) {
            return Array.isArray(this.schedulerDraft?.days) && this.schedulerDraft.days.map(Number).includes(day);
        },

        formatScheduleDays(days) {
            const normalized = this.normalizeScheduleDays(days, false);
            if (normalized.length === 7) return 'Setiap hari';
            if (normalized.length === 5 && [1, 2, 3, 4, 5].every(day => normalized.includes(day))) {
                return 'Senin–Jumat';
            }
            return this.scheduleDayOptions
                .filter(day => normalized.includes(day.value))
                .map(day => day.label)
                .join(', ') || 'Belum memilih hari';
        },

        getScheduleTotalPlays(schedule) {
            return (schedule?.items || []).reduce(
                (total, item) => total + Math.min(100, Math.max(1, Math.round(Number(item.repeatCount) || 1))),
                0
            );
        },

        addScheduleItem() {
            if (this.schedulerDraft) this.schedulerDraft.items.push(this.newScheduleItem());
        },

        removeScheduleItem(index) {
            if (!this.schedulerDraft || this.schedulerDraft.items.length <= 1) return;
            this.schedulerDraft.items.splice(index, 1);
        },

        getScheduleAudioType(file) {
            const supportedTypes = {
                'audio/mpeg': 'audio/mpeg',
                'audio/mp3': 'audio/mpeg',
                'audio/wav': 'audio/wav',
                'audio/x-wav': 'audio/wav',
                'audio/ogg': 'audio/ogg',
                'audio/webm': 'audio/webm',
                'audio/mp4': 'audio/mp4',
                'audio/x-m4a': 'audio/mp4',
                'audio/aac': 'audio/aac',
                'audio/x-aac': 'audio/aac',
                'audio/flac': 'audio/flac',
                'audio/x-flac': 'audio/flac'
            };
            const baseMimeType = String(file?.type || '').split(';')[0].trim().toLowerCase();
            if (supportedTypes[baseMimeType]) return supportedTypes[baseMimeType];

            const extension = String(file?.name || '').split('.').pop().toLowerCase();
            return {
                mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm',
                m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac'
            }[extension] || '';
        },

        getLocalAudioDuration(file) {
            return new Promise(resolve => {
                const audio = document.createElement('audio');
                const objectUrl = URL.createObjectURL(file);
                let completed = false;
                const timeout = setTimeout(() => finish(), 5000);
                const finish = (duration = null) => {
                    if (completed) return;
                    completed = true;
                    clearTimeout(timeout);
                    audio.removeAttribute('src');
                    URL.revokeObjectURL(objectUrl);
                    resolve(Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null);
                };
                audio.preload = 'metadata';
                audio.onloadedmetadata = () => finish(audio.duration);
                audio.onerror = () => finish();
                audio.src = objectUrl;
            });
        },

        async uploadScheduleAudio(event, item) {
            const input = event?.target;
            const file = input?.files?.[0];
            if (!file || !item) return;

            const format = this.getScheduleAudioType(file);
            const maxBytes = this.maxScheduleAudioSizeMb * 1024 * 1024;
            if (!format) {
                input.value = '';
                this.showNotification('Format tidak didukung. Pilih MP3, WAV, OGG, WebM, M4A, AAC, atau FLAC.', 'error');
                return;
            }
            if (file.size > maxBytes) {
                input.value = '';
                this.showNotification(`File terlalu besar. Maksimal ${this.maxScheduleAudioSizeMb} MB.`, 'error');
                return;
            }

            item.uploading = true;
            item.uploadError = '';
            try {
                const durationPromise = this.getLocalAudioDuration(file);
                const response = await fetch('/api/audio/upload', {
                    method: 'POST',
                    headers: {
                        'Content-Type': format,
                        'X-Audio-Name': encodeURIComponent(file.name)
                    },
                    body: file
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) {
                    throw new Error(data.error || data.message || `Upload gagal (${response.status})`);
                }

                item.type = 'audio';
                item.audioUrl = data.audioUrl;
                item.audioName = data.fileName || file.name;
                item.audioSize = data.size || file.size;
                item.audioFormat = data.format || format;
                item.audioDuration = await durationPromise;
                this.showNotification(`Audio “${item.audioName}” berhasil di-upload`, 'success');
            } catch (error) {
                item.uploadError = error.message;
                this.showNotification(`Upload audio gagal: ${error.message}`, 'error');
            } finally {
                item.uploading = false;
                input.value = '';
            }
        },

        formatFileSize(bytes) {
            const value = Number(bytes) || 0;
            if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
            return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        },

        getScheduleItemLabel(item) {
            const repeatCount = Math.min(100, Math.max(1, Math.round(Number(item?.repeatCount) || 1)));
            return `${item?.audioName || 'File audio belum dipilih'} (${repeatCount}x)`;
        },

        saveSchedule() {
            const draft = this.schedulerDraft;
            if (!draft) return;
            const time = String(draft.time || '').match(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
            const selectedDays = draft.selectedDay === 'all'
                ? this.scheduleDayOptions.map(day => day.value)
                : [Number(draft.selectedDay)];
            const days = this.normalizeScheduleDays(selectedDays, false);

            if (!time) return this.showNotification('Pilih jam scheduler yang valid (HH:MM)', 'error');
            if (!days.length) return this.showNotification('Pilih minimal satu hari untuk scheduler', 'error');
            if ((draft.items || []).some(item => item.uploading)) return this.showNotification('Tunggu proses upload audio selesai', 'warning');
            if (!(draft.items || []).length) return this.showNotification('Tambahkan minimal satu file audio', 'error');
            if (draft.items.some(item => !item.audioUrl)) {
                return this.showNotification('Upload file audio pada setiap item scheduler', 'error');
            }

            const items = draft.items.map(item => ({
                type: 'audio',
                audioUrl: item.audioUrl,
                audioName: item.audioName || 'Audio upload',
                audioSize: Number(item.audioSize) || 0,
                audioDuration: item.audioDuration !== null && Number.isFinite(Number(item.audioDuration)) ? Number(item.audioDuration) : null,
                audioFormat: item.audioFormat || 'audio/mpeg',
                repeatCount: Math.min(100, Math.max(1, Math.round(Number(item.repeatCount) || 1))),
                repeatIntervalSeconds: Math.min(3600, Math.max(0, Math.round(Number(item.repeatIntervalSeconds) || 0))),
                priority: item.priority || 'normal'
            }));

            const schedule = {
                id: draft.id || `schedule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: String(draft.name || '').trim() || 'Jadwal tanpa nama',
                time: draft.time,
                days,
                itemIntervalSeconds: Math.min(3600, Math.max(0, Math.round(Number(draft.itemIntervalSeconds) || 0))),
                enabled: draft.enabled !== false,
                items,
                lastRunAt: draft.lastRunAt || null
            };
            const index = this.schedules.findIndex(item => item.id === schedule.id);
            if (index >= 0) this.schedules.splice(index, 1, schedule);
            else this.schedules.push(schedule);
            this.persistSchedules();
            this.showSchedulerModal = false;
            this.schedulerDraft = null;
            this.showNotification(`Scheduler “${schedule.name}” berhasil disimpan`, 'success');
        },

        deleteSchedule(schedule) {
            if (!schedule || !confirm(`Hapus scheduler “${schedule.name}”?`)) return;
            this.schedules = this.schedules.filter(item => item.id !== schedule.id);
            this.persistSchedules();
        },

        toggleSchedule(schedule) {
            schedule.enabled = !schedule.enabled;
            this.persistSchedules();
        },

        persistSchedules() {
            localStorage.setItem('ttsSchedules', JSON.stringify(this.schedules));
        },

        loadSchedules() {
            try {
                const saved = JSON.parse(localStorage.getItem('ttsSchedules') || '[]');
                this.schedules = Array.isArray(saved) ? saved.map(schedule => {
                    const items = Array.isArray(schedule.items)
                        ? schedule.items
                            .filter(item => item?.audioUrl || item?.type === 'audio')
                            .map(item => ({
                                ...item,
                                type: 'audio',
                                repeatCount: Math.min(100, Math.max(1, Math.round(Number(item.repeatCount) || 1))),
                                repeatIntervalSeconds: item.repeatIntervalSeconds === undefined
                                    ? 10
                                    : Math.min(3600, Math.max(0, Math.round(Number(item.repeatIntervalSeconds) || 0)))
                            }))
                        : [];
                    return {
                        ...schedule,
                        days: this.normalizeScheduleDays(schedule.days),
                        enabled: items.length ? schedule.enabled !== false : false,
                        itemIntervalSeconds: Math.min(3600, Math.max(0, Math.round(Number(schedule.itemIntervalSeconds) || 0))),
                        items
                    };
                }).filter(schedule => schedule.items.length) : [];
            } catch (error) {
                console.error('Failed to load schedules:', error);
                this.schedules = [];
            }
        },

        startScheduler() {
            this.stopScheduler();
            this.checkSchedules();
            this.schedulerTimer = setInterval(() => this.checkSchedules(), 1000);
        },

        stopScheduler() {
            if (this.schedulerTimer) clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        },

        getScheduleOccurrence(schedule, now = new Date()) {
            if (!schedule?.time) return null;
            const [hours, minutes] = schedule.time.split(':').map(Number);
            if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
            const days = this.normalizeScheduleDays(schedule.days, false);
            if (!days.includes(now.getDay()) || now.getHours() !== hours || now.getMinutes() !== minutes) return null;
            const occurrence = new Date(now);
            occurrence.setSeconds(0, 0);
            return occurrence;
        },

        checkSchedules() {
            if (!this.schedules.length) return;
            // Alarm hanya ditandai berjalan setelah koneksi tersedia.
            if (!this.socket || !this.socket.connected) return;
            const now = new Date();
            this.schedules.forEach(schedule => {
                if (!schedule.enabled || this.runningScheduleIds.includes(schedule.id)) return;
                const occurrence = this.getScheduleOccurrence(schedule, now);
                if (!occurrence) return;
                const occurrenceKey = occurrence.toISOString();
                if (schedule.lastRunAt === occurrenceKey) return;
                schedule.lastRunAt = occurrenceKey;
                this.persistSchedules();
                this.runSchedule(schedule);
            });
        },

        getScheduleWaiterKey(schedulerRunId, schedulerItem) {
            return `${schedulerRunId || ''}:${schedulerItem || ''}`;
        },

        waitForScheduleItem(schedulerRunId, schedulerItem) {
            const key = this.getScheduleWaiterKey(schedulerRunId, schedulerItem);
            return new Promise(resolve => {
                const timeout = setTimeout(() => {
                    delete this.schedulerItemWaiters[key];
                    resolve({ status: 'client-timeout', schedulerRunId, schedulerItem });
                }, 31 * 60 * 1000);
                this.schedulerItemWaiters[key] = {
                    schedulerRunId,
                    resolve: (data) => {
                        clearTimeout(timeout);
                        delete this.schedulerItemWaiters[key];
                        resolve(data);
                    }
                };
            });
        },

        resolveScheduleItemWaiter(data = {}) {
            if (!data.schedulerRunId || !data.schedulerItem) return false;
            const key = this.getScheduleWaiterKey(data.schedulerRunId, data.schedulerItem);
            const waiter = this.schedulerItemWaiters[key];
            if (!waiter) return false;
            waiter.resolve(data);
            return true;
        },

        cancelSchedulerRun(schedulerRunId, reason = 'cancelled') {
            if (!schedulerRunId) return;
            const state = this.schedulerRunStates[schedulerRunId];
            if (state) {
                state.cancelled = true;
                (state.cancelResolvers || []).splice(0).forEach(resolve => resolve());
            }
            Object.entries(this.schedulerItemWaiters).forEach(([key, waiter]) => {
                if (waiter.schedulerRunId !== schedulerRunId) return;
                waiter.resolve({ status: reason, schedulerRunId });
                delete this.schedulerItemWaiters[key];
            });
        },

        cancelSchedulerRuns(reason = 'cancelled') {
            Object.keys(this.schedulerRunStates).forEach(runId => this.cancelSchedulerRun(runId, reason));
        },

        waitForScheduleDelay(milliseconds, state) {
            if (!milliseconds || state.cancelled) return Promise.resolve();
            return new Promise(resolve => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    state.cancelResolvers = state.cancelResolvers.filter(item => item !== finish);
                    resolve();
                };
                const timer = setTimeout(finish, milliseconds);
                state.cancelResolvers.push(finish);
            });
        },

        async runSchedule(schedule) {
            this.runningScheduleIds.push(schedule.id);
            const totalPlays = this.getScheduleTotalPlays(schedule);
            this.showNotification(`Scheduler “${schedule.name}” mulai (${totalPlays} kali putar)`, 'info');
            const schedulerRunId = `run_${schedule.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const runState = { cancelled: false, cancelResolvers: [] };
            this.schedulerRunStates[schedulerRunId] = runState;
            try {
                for (let index = 0; index < schedule.items.length; index += 1) {
                    if (runState.cancelled) return;
                    const item = schedule.items[index];
                    const repeatCount = Math.min(100, Math.max(1, Math.round(Number(item.repeatCount) || 1)));
                    const repeatIntervalMs = Math.min(3600, Math.max(0, Number(item.repeatIntervalSeconds) || 0)) * 1000;
                    for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
                        if (runState.cancelled || !this.socket?.connected) return;
                        const schedulerItem = `${index + 1}.${repeat}`;
                        const schedulerData = {
                            priority: item.priority || 'normal',
                            timestamp: new Date().toISOString(),
                            schedulerId: schedule.id,
                            schedulerName: schedule.name,
                            schedulerItem,
                            schedulerRunId
                        };
                        if (!item.audioUrl) {
                            this.resolveScheduleItemWaiter({ ...schedulerData, status: 'skipped' });
                            break;
                        }
                        const playbackFinished = this.waitForScheduleItem(schedulerRunId, schedulerItem);
                        this.socket.emit('audio-request', {
                            ...schedulerData,
                            audioUrl: item.audioUrl,
                            fileName: item.audioName || 'Audio upload',
                            audioSize: Number(item.audioSize) || null,
                            duration: item.audioDuration !== null && Number.isFinite(Number(item.audioDuration)) ? Number(item.audioDuration) : null,
                            format: item.audioFormat || 'audio/mpeg'
                        });
                        const playbackResult = await playbackFinished;
                        if (runState.cancelled || playbackResult?.status !== 'ended') return;
                        if (repeat < repeatCount && repeatIntervalMs > 0) {
                            await this.waitForScheduleDelay(repeatIntervalMs, runState);
                        }
                    }
                    if (index < schedule.items.length - 1) {
                        await this.waitForScheduleDelay(Math.max(0, Number(schedule.itemIntervalSeconds) || 0) * 1000, runState);
                    }
                }
                this.showNotification(`Scheduler “${schedule.name}” selesai`, 'success');
            } finally {
                delete this.schedulerRunStates[schedulerRunId];
                this.runningScheduleIds = this.runningScheduleIds.filter(id => id !== schedule.id);
            }
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
                const data = await this.fetchJsonOrThrow('/api/languages', 'Gagal mengambil daftar bahasa');
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
                const data = await this.fetchJsonOrThrow('/api/test', 'Gagal menguji koneksi');
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
