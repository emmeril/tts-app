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
        languages: [],
        history: [],
        notifications: [],
        
        // UI Controls
        charCount: 0,
        maxChars: 5000,
        wordCount: 0,
        showSystemInfoModal: false,
        showHelpModal: false,
        
        // Initialize
        init() {
            this.updateCharCount();
            this.loadLanguages();
            this.loadHistory();
            this.initSocket();
            
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
                    this.socket.emit('ping', { timestamp: Date.now() });
                }
            }, 30000);
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
                reconnectionAttempts: 5,
                reconnectionDelay: 1000,
                timeout: 20000
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
                    url: window.location.href
                });
            });
            
            this.socket.on('welcome', (data) => {
                this.clientId = data.clientId;
                this.clientIdShort = data.clientId.substring(0, 8);
                this.showNotification('Terhubung ke server TTS Multi-Client', 'success');
            });
            
            this.socket.on('connection-status', (data) => {
                this.clientId = data.clientId;
                this.clientIdShort = data.clientId.substring(0, 8);
                this.isMaster = data.isMaster;
                this.masterClientId = data.masterClient;
                this.connectedClients = data.connectedClients || [];
            });
            
            this.socket.on('client-connected', (data) => {
                this.connectedClients = data.connectedClients || [];
                this.showNotification(`Komputer baru terhubung: ${data.clientId.substring(0, 8)}`, 'info');
            });
            
            this.socket.on('client-disconnected', (data) => {
                this.connectedClients = data.connectedClients || [];
                this.showNotification(`Komputer terputus: ${data.clientId.substring(0, 8)}`, 'warning');
            });
            
            this.socket.on('master-changed', (data) => {
                this.masterClientId = data.masterClientId;
                this.isMaster = (this.clientId === data.masterClientId);
                
                if (this.isMaster) {
                    this.showNotification('Anda sekarang adalah Master Controller!', 'success');
                } else if (data.masterClientId) {
                    this.showNotification(`${data.masterClientId.substring(0, 8)} sekarang menjadi Master`, 'info');
                }
            });
            
            this.socket.on('master-role-granted', (data) => {
                this.isMaster = true;
                this.isRequestingMaster = false;
                this.masterClientId = this.clientId;
                this.showNotification(data.message || 'Anda sekarang adalah Master Controller!', 'success');
            });
            
            this.socket.on('master-role-denied', (data) => {
                this.isRequestingMaster = false;
                this.showNotification(`Gagal menjadi Master: ${data.reason}`, 'error');
            });
            
            this.socket.on('master-role-released', (data) => {
                this.isMaster = false;
                this.masterClientId = null;
                this.showNotification(data.message || 'Anda telah melepaskan peran Master', 'info');
            });
            
            this.socket.on('master-disconnected', (data) => {
                this.masterClientId = null;
                this.showNotification(`Master Controller terputus: ${data.disconnectedMasterId}`, 'warning');
            });
            
            this.socket.on('master-needed', (data) => {
                if (!this.isMaster) {
                    this.showNotification(`Master diperlukan! ${data.pendingRequests} permintaan dalam antrian.`, 'warning');
                }
            });
            
            this.socket.on('tts-audio', (data) => {
                console.log('Received TTS audio:', data);
                
                // Store the audio data
                this.currentAudio = data;
                
                // Auto-play if this client is master
                if (this.isMaster && data.audioUrl) {
                    this.playAudio();
                } else if (this.isMaster) {
                    this.showNotification(`Menerima audio dari ${data.fromClientId}`, 'info');
                }
            });
            
            this.socket.on('tts-audio-broadcast', (data) => {
                this.currentAudio = data;
                this.showNotification(`Broadcast audio dari ${data.fromClientId}`, 'info');
                
                // Auto-play broadcast
                this.playAudio();
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
                    master: data.masterClientId,
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
                if (!this.isMaster && this.currentAudio) {
                    this.playAudio();
                }
            });
            
            this.socket.on('stop-audio-command', () => {
                this.stopAudio();
            });
            
            this.socket.on('tts-notification', (data) => {
                if (data.fromClientId !== this.clientId) {
                    this.showNotification(`${data.fromClientId} mengirim teks: "${data.textPreview}"`, 'info');
                }
            });
            
            this.socket.on('pong', (data) => {
                // Update last activity
                console.log('Pong received:', data);
            });
            
            this.socket.on('disconnect', (reason) => {
                this.serverStatus = 'disconnected';
                this.serverStatusText = 'Terputus dari server';
                this.showNotification('Terputus dari server. Mencoba menyambung ulang...', 'error');
                console.log('Socket disconnected:', reason);
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
        },
        
        // Request master role
        requestMasterRole() {
            if (this.isMaster) return;
            
            this.isRequestingMaster = true;
            this.socket.emit('request-master-role', {
                timestamp: new Date().toISOString(),
                clientId: this.clientId
            });
            
            this.showNotification('Mengirim permintaan menjadi Master...', 'info');
        },
        
        // Release master role
        releaseMasterRole() {
            if (!this.isMaster) return;
            
            this.socket.emit('release-master-role');
            this.isMaster = false;
            this.masterClientId = null;
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
    
    this.isLoading = true;
    
    try {
        // Send TTS request via Socket.io
        this.socket.emit('tts-request', {
            text: this.text.trim(), // Trim whitespace
            language: this.language,
            speed: Math.max(0.5, Math.min(parseFloat(this.speed) || 1.0, 2.0)),
            priority: this.priority,
            timestamp: new Date().toISOString()
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
                timestamp: new Date().toISOString()
            });
            
            this.showNotification('Mengirim broadcast ke semua komputer...', 'info');
        },
        
        // Play audio
        playAudio() {
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
                    
                    // Notify server about playback status
                    this.socket.emit('audio-status', 'playing');
                    
                    // If this client is master, notify others to play
                    if (this.isMaster) {
                        this.socket.emit('play-audio', this.currentAudio);
                    }
                    
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
                
                // If this client is master, notify others to stop
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
            if (this.isMaster) return 'Kirim ke Master';
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
    
    // Log untuk debugging
    console.log(`Char count: ${this.charCount}, Word count: ${this.wordCount}, Text: "${this.text.substring(0, 50)}"`);
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
        }
    };
}