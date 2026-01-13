function ttsApp() {
    return {
        // State
        text: '',
        language: 'id-ID',
        speed: 1.0,
        isLoading: false,
        isPlaying: false,
        result: null,
        error: '',
        serverStatus: 'disconnected',
        languages: [],
        history: [],
        maxChars: 200,
        showAboutModal: false,
        showUsageModal: false,
        
        // Computed
        get charCount() {
            return this.text.length;
        },
        get wordCount() {
            return this.text.trim() ? this.text.trim().split(/\s+/).length : 0;
        },
        get serverStatusText() {
            return this.serverStatus === 'connected' ? 'Server Terhubung' : 'Server Terputus';
        },
        
        // Lifecycle
        async init() {
            console.log('Initializing TTS App...');
            
            // Load saved data
            this.loadSavedData();
            
            // Load languages
            await this.loadLanguages();
            
            // Check server status
            await this.checkServerStatus();
            
            // Listen for audio events
            this.setupAudioListeners();
            
            console.log('TTS App initialized');
        },
        
        // Methods
        async loadLanguages() {
            try {
                const response = await fetch('/api/languages');
                const data = await response.json();
                
                if (data.success) {
                    this.languages = data.languages;
                    console.log(`Loaded ${this.languages.length} languages`);
                } else {
                    // Fallback languages
                    this.languages = [
                        { code: 'id-ID', name: 'Bahasa Indonesia', nativeName: 'Bahasa Indonesia' },
                        { code: 'en-US', name: 'English (US)', nativeName: 'English' },
                        { code: 'es-ES', name: 'Spanish', nativeName: 'Español' },
                        { code: 'fr-FR', name: 'French', nativeName: 'Français' },
                        { code: 'de-DE', name: 'German', nativeName: 'Deutsch' }
                    ];
                }
            } catch (error) {
                console.error('Failed to load languages:', error);
                this.languages = [
                    { code: 'id-ID', name: 'Bahasa Indonesia', nativeName: 'Bahasa Indonesia' },
                    { code: 'en-US', name: 'English (US)', nativeName: 'English' }
                ];
            }
        },
        
        async checkServerStatus() {
            try {
                const response = await fetch('/api/health');
                if (response.ok) {
                    this.serverStatus = 'connected';
                    return true;
                } else {
                    this.serverStatus = 'disconnected';
                    return false;
                }
            } catch (error) {
                this.serverStatus = 'disconnected';
                console.error('Server status check failed:', error);
                return false;
            }
        },
        
        loadSavedData() {
            // Load text from localStorage
            const savedText = localStorage.getItem('tts_text');
            if (savedText) {
                this.text = savedText;
            }
            
            // Load history from localStorage
            const savedHistory = localStorage.getItem('tts_history');
            if (savedHistory) {
                try {
                    this.history = JSON.parse(savedHistory);
                } catch (e) {
                    this.history = [];
                }
            }
            
            // Load settings from localStorage
            const savedLanguage = localStorage.getItem('tts_language');
            if (savedLanguage) {
                this.language = savedLanguage;
            }
            
            const savedSpeed = localStorage.getItem('tts_speed');
            if (savedSpeed) {
                this.speed = parseFloat(savedSpeed);
            }
        },
        
        saveData() {
            localStorage.setItem('tts_text', this.text);
            localStorage.setItem('tts_language', this.language);
            localStorage.setItem('tts_speed', this.speed.toString());
        },
        
        updateCharCount() {
            // Auto-save when typing
            this.saveData();
            
            // Truncate if exceeds max
            if (this.text.length > this.maxChars) {
                this.text = this.text.substring(0, this.maxChars);
            }
        },
        
        clearText() {
            this.text = '';
            this.saveData();
        },
        
        async pasteText() {
            try {
                const text = await navigator.clipboard.readText();
                this.text = text.substring(0, this.maxChars);
                this.saveData();
            } catch (error) {
                this.error = 'Gagal membaca dari clipboard';
            }
        },
        
        speakText() {
            if (!this.text.trim()) return;
            
            // Use Web Speech API for quick preview
            if ('speechSynthesis' in window) {
                const utterance = new SpeechSynthesisUtterance(this.text);
                utterance.lang = this.language;
                utterance.rate = this.speed;
                window.speechSynthesis.speak(utterance);
                this.isPlaying = true;
            }
        },
        
        async convertToSpeech() {
            if (!this.text.trim()) {
                this.error = 'Masukkan teks terlebih dahulu';
                return;
            }
            
            if (this.text.length > this.maxChars) {
                this.error = `Teks terlalu panjang. Maksimal ${this.maxChars} karakter.`;
                return;
            }
            
            this.isLoading = true;
            this.error = '';
            this.result = null;
            
            try {
                // Check server status first
                const isConnected = await this.checkServerStatus();
                if (!isConnected) {
                    throw new Error('Server tidak terhubung. Coba refresh halaman.');
                }
                
                // Send request to backend
                const response = await fetch('/api/tts', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        text: this.text,
                        language: this.language,
                        speed: this.speed
                    })
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || 'Gagal mengonversi teks');
                }
                
                if (!data.success) {
                    throw new Error(data.error || 'Konversi gagal');
                }
                
                // Success!
                this.result = data;
                
                // Add to history
                this.addToHistory();
                
                // Auto-play audio
                setTimeout(() => {
                    this.playAudio();
                }, 500);
                
            } catch (error) {
                console.error('Conversion error:', error);
                this.error = error.message;
                
                // Fallback to browser TTS
                this.fallbackToBrowserTTS();
            } finally {
                this.isLoading = false;
            }
        },
        
        fallbackToBrowserTTS() {
            if (!('speechSynthesis' in window)) {
                this.error += ' Browser Anda tidak mendukung Text-to-Speech.';
                return;
            }
            
            // Create browser TTS result
            const duration = this.estimateDuration(this.text, this.speed);
            this.result = {
                audioUrl: '',
                duration: duration,
                textLength: this.text.length,
                language: this.language,
                source: 'browser',
                truncated: false
            };
            
            // Add to history
            this.addToHistory();
            
            // Speak immediately
            this.speakText();
        },
        
        estimateDuration(text, speed) {
            const charsPerMinute = 150 * speed;
            const durationInSeconds = (text.length / charsPerMinute) * 60;
            return Math.max(0.5, Math.round(durationInSeconds * 10) / 10);
        },
        
        addToHistory() {
            const historyItem = {
                id: Date.now(),
                text: this.text,
                language: this.language,
                speed: this.speed,
                timestamp: new Date().toISOString()
            };
            
            this.history.push(historyItem);
            
            // Keep only last 10 items
            if (this.history.length > 10) {
                this.history = this.history.slice(-10);
            }
            
            // Save to localStorage
            localStorage.setItem('tts_history', JSON.stringify(this.history));
        },
        
        loadHistoryItem(item) {
            this.text = item.text;
            this.language = item.language;
            this.speed = item.speed;
            this.saveData();
        },
        
        clearHistory() {
            if (confirm('Hapus semua riwayat?')) {
                this.history = [];
                localStorage.removeItem('tts_history');
            }
        },
        
        setupAudioListeners() {
            document.addEventListener('play', () => {
                this.isPlaying = true;
            });
            
            document.addEventListener('pause', () => {
                this.isPlaying = false;
            });
            
            document.addEventListener('ended', () => {
                this.isPlaying = false;
            });
        },
        
        playAudio() {
            if (!this.result) return;
            
            if (this.result.source === 'browser') {
                this.speakText();
            } else {
                const audioElement = document.querySelector('.audio-element');
                if (audioElement) {
                    audioElement.play().catch(error => {
                        console.error('Audio playback error:', error);
                        this.error = 'Gagal memutar audio: ' + error.message;
                    });
                }
            }
        },
        
        pauseAudio() {
            if (this.result.source === 'browser') {
                window.speechSynthesis.pause();
            } else {
                const audioElement = document.querySelector('.audio-element');
                if (audioElement) {
                    audioElement.pause();
                }
            }
            this.isPlaying = false;
        },
        
        stopSpeech() {
            if (this.result?.source === 'browser') {
                window.speechSynthesis.cancel();
            } else {
                const audioElement = document.querySelector('.audio-element');
                if (audioElement) {
                    audioElement.pause();
                    audioElement.currentTime = 0;
                }
            }
            this.isPlaying = false;
        },
        
        async downloadAudio() {
            if (!this.result || !this.result.audioUrl) {
                this.error = 'Tidak ada audio untuk diunduh';
                return;
            }
            
            try {
                const response = await fetch(this.result.audioUrl);
                const blob = await response.blob();
                
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                
                const timestamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
                const lang = this.getLanguageCode(this.result.language);
                a.download = `tts-${lang}-${timestamp}.mp3`;
                
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            } catch (error) {
                console.error('Download error:', error);
                this.error = 'Gagal mengunduh audio';
            }
        },
        
        shareAudio() {
            if (!this.result) return;
            
            if (navigator.share) {
                navigator.share({
                    title: 'Hasil Konversi TTS',
                    text: `Saya mengonversi teks ke suara: "${this.truncateText(this.text, 50)}"`,
                    url: window.location.href
                }).catch(error => {
                    console.log('Sharing cancelled:', error);
                });
            } else {
                // Fallback: copy to clipboard
                navigator.clipboard.writeText(this.text).then(() => {
                    alert('Teks disalin ke clipboard!');
                });
            }
        },
        
        async testConnection() {
            try {
                const response = await fetch('/api/test');
                const data = await response.json();
                
                if (data.success) {
                    alert(`✅ ${data.message}\nStatus: ${data.status}`);
                } else {
                    alert(`❌ ${data.message}\nError: ${data.error}`);
                }
            } catch (error) {
                alert(`❌ Test koneksi gagal: ${error.message}`);
            }
        },
        
        // Helper methods
        getLanguageName(code) {
            const lang = this.languages.find(l => l.code === code);
            return lang ? lang.name : code;
        },
        
        getLanguageCode(langName) {
            const lang = this.languages.find(l => l.name === langName);
            return lang ? lang.code : langName;
        },
        
        truncateText(text, maxLength = 50) {
            if (text.length <= maxLength) return text;
            return text.substring(0, maxLength) + '...';
        },
        
        formatTime(isoString) {
            const date = new Date(isoString);
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        },
        
        showAbout() {
            this.showAboutModal = true;
        },
        
        showUsage() {
            this.showUsageModal = true;
        }
    };
}