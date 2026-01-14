const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');

// Rate limiter untuk mencegah abuse
const rateLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT) || 100, // 100 request
  duration: parseInt(process.env.RATE_LIMIT_WINDOW) || 900, // per 15 menit
});

class GoogleTTSService {
  constructor() {
    this.baseUrl = process.env.GOOGLE_TTS_API || 'https://translate.google.com/translate_tts';
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Referer': 'https://translate.google.com/',
      'Origin': 'https://translate.google.com',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Range': 'bytes=0-',
      'Sec-Fetch-Dest': 'audio',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-origin',
    };
  }

  /**
   * Map kode bahasa ke format Google TTS
   */
  mapLanguageCode(language) {
    const languageMap = {
      // Bahasa Asia
      'id-ID': 'id',          // Bahasa Indonesia
      'id': 'id',
      'ms-MY': 'ms',          // Bahasa Melayu
      'th-TH': 'th',          // Thai
      'vi-VN': 'vi',          // Vietnamese
      'ko-KR': 'ko',          // Korean
      'ja-JP': 'ja',          // Japanese
      'zh-CN': 'zh-CN',       // Chinese Simplified
      'zh-TW': 'zh-TW',       // Chinese Traditional
      
      // Bahasa Eropa
      'en-US': 'en',
      'en-GB': 'en-GB',
      'es-ES': 'es',
      'fr-FR': 'fr',
      'de-DE': 'de',
      'it-IT': 'it',
      'pt-BR': 'pt',
      'pt-PT': 'pt-PT',
      'ru-RU': 'ru',
      'nl-NL': 'nl',
      'pl-PL': 'pl',
      'tr-TR': 'tr',
      'el-GR': 'el',
      'sv-SE': 'sv',
      'da-DK': 'da',
      'fi-FI': 'fi',
      'no-NO': 'no',
      'cs-CZ': 'cs',
      'hu-HU': 'hu',
      'ro-RO': 'ro',
      
      // Bahasa Lainnya
      'ar-SA': 'ar',
      'he-IL': 'iw',
      'hi-IN': 'hi',
      'bn-BD': 'bn',
      'fa-IR': 'fa',
      'ur-PK': 'ur',
    };
    
    return languageMap[language] || 'en';
  }

  /**
   * Optimasi teks untuk pengucapan yang lebih natural
   */
  optimizeTextForSpeech(text) {
    let optimized = text;
    
    // Normalisasi spasi dan tanda baca
    optimized = optimized.replace(/\s+/g, ' ');
    optimized = optimized.replace(/\s+([.,!?;:])/g, '$1');
    optimized = optimized.replace(/([.,!?;:])(\S)/g, '$1 $2');
    
    // Optimasi angka
    optimized = optimized.replace(/(\d+)/g, (match) => {
      if (parseInt(match) < 1000) {
        return match;
      }
      return match.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    });
    
    // Optimasi singkatan umum
    const abbreviations = {
      'dr.': 'dokter',
      'Dr.': 'Dokter',
      'Mr.': 'Mister',
      'Mrs.': 'Mistress',
      'Ms.': 'Miss',
      'etc.': 'et cetera',
      'e.g.': 'contohnya',
      'i.e.': 'yaitu',
      'vs.': 'versus',
      'kg': 'kilogram',
      'km': 'kilometer',
      'cm': 'sentimeter',
      'mm': 'milimeter',
      'ml': 'mililiter',
      '°C': 'derajat Celsius',
    };
    
    Object.keys(abbreviations).forEach(abbr => {
      const regex = new RegExp(`\\b${abbr}\\b`, 'g');
      optimized = optimized.replace(regex, abbreviations[abbr]);
    });
    
    // Tambahkan jeda natural untuk kalimat panjang
    if (optimized.length > 50) {
      optimized = optimized.replace(/([,;:])\s+/g, '$1<pause>');
    }
    
    return optimized.trim();
  }

  /**
   * Truncate text jika terlalu panjang
   */
  truncateText(text, maxLength = 200) {
    if (text.length <= maxLength) return text;
    
    let truncated = text.substring(0, maxLength);
    
    const sentenceEnd = truncated.lastIndexOf('. ');
    const questionEnd = truncated.lastIndexOf('? ');
    const exclamationEnd = truncated.lastIndexOf('! ');
    
    const bestEnd = Math.max(sentenceEnd, questionEnd, exclamationEnd);
    
    if (bestEnd > maxLength * 0.6) {
      truncated = truncated.substring(0, bestEnd + 1);
    } else {
      const commaPos = truncated.lastIndexOf(', ');
      const semicolonPos = truncated.lastIndexOf('; ');
      const punctuationPos = Math.max(commaPos, semicolonPos);
      
      if (punctuationPos > maxLength * 0.5) {
        truncated = truncated.substring(0, punctuationPos + 1);
      } else {
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > maxLength * 0.4) {
          truncated = truncated.substring(0, lastSpace);
        }
      }
    }
    
    return truncated + (truncated.endsWith('.') ? '' : '.') + '..';
  }

  /**
   * Validasi input
   */
  validateInput(text, language) {
    const errors = [];
    
    // Cek jika text ada dan bertipe string
    if (!text || typeof text !== 'string') {
        errors.push('Text harus berupa string');
        return errors; // Return early karena tidak perlu cek lainnya
    }
    
    // Cek jika text hanya whitespace
    if (text.trim().length === 0) {
        errors.push('Text tidak boleh kosong atau hanya spasi');
    }
    
    // Cek panjang text
    if (text.length > 5000) {
        errors.push(`Text terlalu panjang (${text.length} karakter, maksimal 5000)`);
    }
    
    // Cek jika language ada
    if (!language || language.trim().length === 0) {
        errors.push('Language tidak boleh kosong');
    }
    
    console.log(`Validation for text (${text.length} chars):`, errors.length > 0 ? errors : 'Valid');
    return errors;
  }

  /**
   * Konversi text ke speech
   */
  async convertTextToSpeech({ text, language = 'id-ID', speed = 0.9, pitch = 1.0 }) {
    try {
        // Validasi input
        const validationErrors = this.validateInput(text, language);
        if (validationErrors.length > 0) {
            throw new Error(validationErrors.join(', '));
        }

        // Apply rate limiting
        try {
            await rateLimiter.consume('google-tts');
        } catch (rateLimitError) {
            throw new Error('Rate limit exceeded. Silakan coba lagi nanti.');
        }

        // Optimasi teks
        const optimizedText = this.optimizeTextForSpeech(text);
        
        // Truncate text jika terlalu panjang
        const truncatedText = this.truncateText(optimizedText, 200);
        
        // Map language code
        const langCode = this.mapLanguageCode(language);
        
        // Parameter untuk request
        const params = new URLSearchParams({
            ie: 'UTF-8',
            tl: langCode,
            client: 'tw-ob',
            q: truncatedText,
            ttsspeed: speed.toString(),
            textlen: truncatedText.length.toString(),
            idx: '0',
            total: '1',
            prev: 'input',
        });
        
        // Untuk beberapa bahasa, tambahkan parameter khusus
        if (['id', 'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko'].includes(langCode)) {
            params.append('tk', this.generateToken(truncatedText));
        }
        
        const ttsUrl = `${this.baseUrl}?${params.toString()}`;
        
        console.log(`[${new Date().toISOString()}] Google TTS Request: ${langCode}, Length: ${truncatedText.length}, Speed: ${speed}`);
        
        // Konfigurasi Axios
        const maxSizeMB = parseInt(process.env.MAX_AUDIO_SIZE_MB) || 2; // Default 2MB
        const maxSizeBytes = maxSizeMB * 1024 * 1024; // Convert MB to bytes
        
        console.log(`Axios Config: maxContentLength=${maxSizeBytes} bytes (${maxSizeMB} MB)`);
        
        // Request ke Google TTS
        const response = await axios.get(ttsUrl, {
            responseType: 'arraybuffer',
            timeout: parseInt(process.env.REQUEST_TIMEOUT) || 40000, // 40 detik
            headers: {
                ...this.defaultHeaders,
                'Accept-Encoding': 'identity',
                'DNT': '1',
                'Accept': 'audio/mpeg, audio/*',
                'Connection': 'keep-alive',
            },
            // FIX: Gunakan nilai dalam bytes yang benar
            maxContentLength: maxSizeBytes,
            maxBodyLength: maxSizeBytes,
            
            // Tambahkan konfigurasi untuk response yang lebih baik
            maxRedirects: 5,
            decompress: true,
            
            // Validasi status (Google TTS biasanya return 200)
            validateStatus: function (status) {
                return status >= 200 && status < 300;
            }
        });
        
        // Debug: log response info
        console.log(`Response Status: ${response.status}, Content-Type: ${response.headers['content-type']}, Size: ${response.data ? response.data.length : 0} bytes`);
        
        // Validasi response
        if (!response.data || response.data.length === 0) {
            throw new Error('Google TTS tidak mengembalikan data audio');
        }
        
        if (response.data.length > maxSizeBytes) {
            console.warn(`Audio size ${response.data.length} bytes exceeds limit ${maxSizeBytes} bytes`);
        }
        
        // Cek format audio
        const audioFormat = this.detectAudioFormat(response.data);
        console.log(`Detected audio format: ${audioFormat}, Size: ${response.data.length} bytes`);
        
        // Konversi ke base64
        const audioBase64 = Buffer.from(response.data).toString('base64');
        const audioDataUrl = `data:${audioFormat};base64,${audioBase64}`;
        
        // Hitung durasi estimasi
        const duration = this.estimateDuration(truncatedText, speed);
        
        return {
            success: true,
            audioUrl: audioDataUrl,
            duration: duration,
            textLength: truncatedText.length,
            originalTextLength: text.length,
            language: language,
            languageCode: langCode,
            speed: speed,
            pitch: pitch,
            format: audioFormat,
            truncated: truncatedText.length < text.length,
            optimized: optimizedText !== text,
            voiceGender: 'female',
            timestamp: new Date().toISOString(),
            audioSize: response.data.length
        };
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Google TTS Service Error:`, {
            message: error.message,
            code: error.code,
            response: error.response ? {
                status: error.response.status,
                headers: error.response.headers
            } : null,
            config: error.config ? {
                url: error.config.url,
                method: error.config.method,
                timeout: error.config.timeout,
                maxContentLength: error.config.maxContentLength
            } : null
        });
        
        let userMessage = 'Gagal mengonversi teks ke suara';
        
        if (error.response) {
            userMessage = `Google TTS menolak permintaan (Status: ${error.response.status}). Coba ganti bahasa atau kurangi teks.`;
        } else if (error.code === 'ECONNABORTED') {
            userMessage = 'Timeout: Google TTS tidak merespons. Coba lagi nanti.';
        } else if (error.message.includes('Rate limit')) {
            userMessage = error.message;
        } else if (error.message.includes('maxContentLength')) {
            userMessage = 'Response audio terlalu besar. Coba teks yang lebih pendek.';
        } else if (error.message.includes('ENOTFOUND')) {
            userMessage = 'Tidak dapat terhubung ke Google TTS. Periksa koneksi internet.';
        }
        
        throw new Error(`${userMessage} (Detail: ${error.message})`);
    }
  }

  /**
   * Generate token untuk beberapa bahasa (optional)
   */
  generateToken(text) {
    const timestamp = Date.now();
    return Buffer.from(`${text}-${timestamp}`).toString('base64').substring(0, 20);
  }

  /**
   * Deteksi format audio dari data
   */
  detectAudioFormat(audioData) {
    const header = audioData.slice(0, 4);
    
    if (header[0] === 0xFF && header[1] === 0xFB) {
      return 'audio/mp3';
    } else if (header[0] === 0x4F && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53) {
      return 'audio/ogg';
    } else if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
      return 'audio/wav';
    }
    
    return 'audio/mp3';
  }

  /**
   * Estimasi durasi audio
   */
  estimateDuration(text, speed) {
    const charsPerMinuteMap = {
      'id': 160, 'ms': 160, 'en': 150, 'es': 150, 'fr': 140, 
      'de': 140, 'it': 140, 'pt': 140, 'ru': 120, 'ja': 100,
      'ko': 100, 'zh': 80, 'th': 120, 'vi': 130, 'ar': 110
    };
    
    const langCode = this.mapLanguageCode('id-ID');
    const baseCharsPerMinute = charsPerMinuteMap[langCode] || 150;
    const adjustedCharsPerMinute = baseCharsPerMinute * speed;
    
    const durationInSeconds = (text.length / adjustedCharsPerMinute) * 60;
    
    const naturalPauses = (text.match(/[.,!?;:]/g) || []).length;
    const pauseTime = naturalPauses * 0.3;
    
    return Math.max(0.5, Math.round((durationInSeconds + pauseTime) * 10) / 10);
  }

  /**
   * Mendapatkan daftar bahasa yang didukung
   */
  getSupportedLanguages() {
    return [
      { code: 'id-ID', name: 'Bahasa Indonesia', nativeName: 'Bahasa Indonesia', voiceGender: 'female', clarity: 'high' },
      { code: 'en-US', name: 'English (US)', nativeName: 'English', voiceGender: 'female', clarity: 'high' },
      { code: 'en-GB', name: 'English (UK)', nativeName: 'English', voiceGender: 'female', clarity: 'high' },
      { code: 'es-ES', name: 'Spanish', nativeName: 'Español', voiceGender: 'female', clarity: 'high' },
      { code: 'fr-FR', name: 'French', nativeName: 'Français', voiceGender: 'female', clarity: 'high' },
      { code: 'de-DE', name: 'German', nativeName: 'Deutsch', voiceGender: 'female', clarity: 'high' },
      { code: 'it-IT', name: 'Italian', nativeName: 'Italiano', voiceGender: 'female', clarity: 'high' },
      { code: 'pt-BR', name: 'Portuguese (BR)', nativeName: 'Português', voiceGender: 'female', clarity: 'high' },
      { code: 'ru-RU', name: 'Russian', nativeName: 'Русский', voiceGender: 'female', clarity: 'medium' },
      { code: 'ja-JP', name: 'Japanese', nativeName: '日本語', voiceGender: 'female', clarity: 'high' },
      { code: 'ko-KR', name: 'Korean', nativeName: '한국어', voiceGender: 'female', clarity: 'high' },
      { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '中文 (简体)', voiceGender: 'female', clarity: 'high' },
      { code: 'ar-SA', name: 'Arabic', nativeName: 'العربية', voiceGender: 'female', clarity: 'medium' },
      { code: 'hi-IN', name: 'Hindi', nativeName: 'हिन्दी', voiceGender: 'female', clarity: 'medium' },
      { code: 'th-TH', name: 'Thai', nativeName: 'ไทย', voiceGender: 'female', clarity: 'high' },
      { code: 'vi-VN', name: 'Vietnamese', nativeName: 'Tiếng Việt', voiceGender: 'female', clarity: 'high' },
      { code: 'ms-MY', name: 'Malay', nativeName: 'Bahasa Melayu', voiceGender: 'female', clarity: 'high' },
    ];
  }

  /**
   * Rekomendasi pengaturan
   */
  getVoiceRecommendations() {
    return {
      recommendedLanguages: ['id-ID', 'en-US', 'ja-JP', 'ko-KR', 'th-TH'],
      optimalSpeed: 0.85,
      textOptimizationTips: [
        'Gunakan kalimat pendek dan jelas',
        'Hindari singkatan yang tidak umum',
        'Gunakan tanda baca yang tepat',
        'Batasi panjang kalimat maksimal 20 kata',
      ],
      apiTips: [
        'Gunakan speed antara 0.8-1.0 untuk kejelasan maksimal',
        'Bahasa Indonesia dan Inggris memiliki suara paling natural',
        'Optimasi teks sebelum dikonversi untuk hasil terbaik',
      ]
    };
  }

  /**
   * Test koneksi ke Google TTS
   */
  async testConnection() {
    try {
      const testText = 'Halo, ini adalah uji koneksi TTS';
      const testLang = 'id';
      
      const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: testLang,
        client: 'tw-ob',
        q: testText,
        ttsspeed: '0.9',
      });
      
      const testUrl = `${this.baseUrl}?${params.toString()}`;
      
      const response = await axios.head(testUrl, {
        timeout: 15000,
        headers: this.defaultHeaders,
      });
      
      return {
        success: true,
        status: response.status,
        message: 'Google TTS dapat diakses - Siap digunakan',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Google TTS tidak dapat diakses',
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = new GoogleTTSService();
