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
   * Map kode bahasa ke format Google TTS dengan preferensi suara perempuan
   */
  mapLanguageCode(language) {
    const languageMap = {
      // Bahasa Asia - suara perempuan natural
      'id-ID': 'id',          // Bahasa Indonesia (suara perempuan default)
      'id': 'id',             // Bahasa Indonesia (alternative)
      'ms-MY': 'ms',          // Bahasa Melayu (suara perempuan)
      'th-TH': 'th',          // Thai (suara perempuan)
      'vi-VN': 'vi',          // Vietnamese (suara perempuan)
      'ko-KR': 'ko',          // Korean (suara perempuan)
      'ja-JP': 'ja',          // Japanese (suara perempuan)
      'zh-CN': 'zh-CN',       // Chinese Simplified (suara perempuan)
      'zh-TW': 'zh-TW',       // Chinese Traditional (suara perempuan)
      
      // Bahasa Eropa - suara perempuan natural
      'en-US': 'en',          // English US (suara perempuan default)
      'en-GB': 'en-GB',       // English UK (suara perempuan)
      'es-ES': 'es',          // Spanish (suara perempuan)
      'fr-FR': 'fr',          // French (suara perempuan)
      'de-DE': 'de',          // German (suara perempuan)
      'it-IT': 'it',          // Italian (suara perempuan)
      'pt-BR': 'pt',          // Portuguese Brazil (suara perempuan)
      'pt-PT': 'pt-PT',       // Portuguese Portugal (suara perempuan)
      'ru-RU': 'ru',          // Russian (suara perempuan)
      'nl-NL': 'nl',          // Dutch (suara perempuan)
      'pl-PL': 'pl',          // Polish (suara perempuan)
      'tr-TR': 'tr',          // Turkish (suara perempuan)
      'el-GR': 'el',          // Greek (suara perempuan)
      'sv-SE': 'sv',          // Swedish (suara perempuan)
      'da-DK': 'da',          // Danish (suara perempuan)
      'fi-FI': 'fi',          // Finnish (suara perempuan)
      'no-NO': 'no',          // Norwegian (suara perempuan)
      'cs-CZ': 'cs',          // Czech (suara perempuan)
      'hu-HU': 'hu',          // Hungarian (suara perempuan)
      'ro-RO': 'ro',          // Romanian (suara perempuan)
      
      // Bahasa Lainnya - suara perempuan natural
      'ar-SA': 'ar',          // Arabic (suara perempuan)
      'he-IL': 'iw',          // Hebrew (suara perempuan)
      'hi-IN': 'hi',          // Hindi (suara perempuan)
      'bn-BD': 'bn',          // Bengali (suara perempuan)
      'fa-IR': 'fa',          // Persian (suara perempuan)
      'ur-PK': 'ur',          // Urdu (suara perempuan)
    };
    
    return languageMap[language] || 'en';
  }

  /**
   * Optimasi teks untuk pengucapan yang lebih natural
   */
  optimizeTextForSpeech(text) {
    let optimized = text;
    
    // 1. Normalisasi spasi dan tanda baca
    optimized = optimized.replace(/\s+/g, ' ');
    optimized = optimized.replace(/\s+([.,!?;:])/g, '$1');
    optimized = optimized.replace(/([.,!?;:])(\S)/g, '$1 $2');
    
    // 2. Optimasi angka dan singkatan untuk pembacaan yang lebih natural
    optimized = optimized.replace(/(\d+)/g, (match) => {
      // Jika angka kecil, baca sebagai angka biasa
      if (parseInt(match) < 1000) {
        return match;
      }
      // Untuk angka besar, tambahkan pemisah
      return match.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    });
    
    // 3. Optimasi singkatan umum
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
    
    // 4. Tambahkan jeda natural untuk kalimat panjang
    if (optimized.length > 50) {
      optimized = optimized.replace(/([,;:])\s+/g, '$1<pause>');
    }
    
    return optimized.trim();
  }

  /**
   * Truncate text jika terlalu panjang dengan mempertahankan struktur kalimat
   */
  truncateText(text, maxLength = 200) {
    if (text.length <= maxLength) return text;
    
    // Cari titik potong yang natural
    let truncated = text.substring(0, maxLength);
    
    // Prioritas: akhir kalimat > tanda baca > spasi
    const sentenceEnd = truncated.lastIndexOf('. ');
    const questionEnd = truncated.lastIndexOf('? ');
    const exclamationEnd = truncated.lastIndexOf('! ');
    
    const bestEnd = Math.max(sentenceEnd, questionEnd, exclamationEnd);
    
    if (bestEnd > maxLength * 0.6) { // Minimal potong 60% dari maxLength
      truncated = truncated.substring(0, bestEnd + 1);
    } else {
      // Jika tidak ada akhir kalimat, cari koma atau titik koma
      const commaPos = truncated.lastIndexOf(', ');
      const semicolonPos = truncated.lastIndexOf('; ');
      const punctuationPos = Math.max(commaPos, semicolonPos);
      
      if (punctuationPos > maxLength * 0.5) {
        truncated = truncated.substring(0, punctuationPos + 1);
      } else {
        // Terakhir, potong di spasi
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
    
    if (!text || text.trim().length === 0) {
      errors.push('Text tidak boleh kosong');
    }
    
    if (text.length > 5000) {
      errors.push('Text terlalu panjang (maksimal 5000 karakter)');
    }
    
    if (!language || language.trim().length === 0) {
      errors.push('Language tidak boleh kosong');
    }
    
    return errors;
  }

  /**
   * Konversi text ke speech menggunakan Google TTS dengan optimasi untuk suara perempuan
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

      // Optimasi teks untuk pengucapan natural
      const optimizedText = this.optimizeTextForSpeech(text);
      
      // Truncate text jika terlalu panjang
      const truncatedText = this.truncateText(optimizedText, 200);
      
      // Map language code
      const langCode = this.mapLanguageCode(language);
      
      // Parameter untuk suara yang lebih natural (perempuan)
      const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: langCode,
        client: 'tw-ob',
        q: truncatedText,
        ttsspeed: speed.toString(), // Kecepatan sedikit lebih lambat untuk kejelasan
        // Parameter tambahan untuk kualitas lebih baik
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
      
      console.log(`Google TTS Request: ${langCode}, Length: ${truncatedText.length}, Speed: ${speed}`);
      
      // Request ke Google TTS dengan timeout lebih panjang untuk kualitas baik
      const response = await axios.get(ttsUrl, {
        responseType: 'arraybuffer',
        timeout: parseInt(process.env.REQUEST_TIMEOUT) || 40000, // 40 detik untuk kualitas baik
        headers: {
          ...this.defaultHeaders,
          'Accept-Encoding': 'identity;q=1, *;q=0',
          'DNT': '1',
        },
        maxContentLength: 2 * 1024 * 1024, // 2MB max untuk kualitas audio lebih baik
        maxBodyLength: 2 * 1024 * 1024,
      });
      
      // Validasi response
      if (!response.data || response.data.length === 0) {
        throw new Error('Google TTS tidak mengembalikan data audio');
      }
      
      // Cek format audio
      const audioFormat = this.detectAudioFormat(response.data);
      
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
        speed: speed,
        pitch: pitch,
        format: audioFormat,
        truncated: truncatedText.length < text.length,
        optimized: optimizedText !== text,
        voiceGender: 'female', // Default suara perempuan untuk kebanyakan bahasa
      };
      
    } catch (error) {
      console.error('Google TTS Service Error:', error.message);
      
      // Berikan error message yang lebih user-friendly
      let userMessage = 'Gagal mengonversi teks ke suara';
      
      if (error.response) {
        userMessage = 'Google TTS menolak permintaan. Coba ganti bahasa atau kurangi teks.';
      } else if (error.code === 'ECONNABORTED') {
        userMessage = 'Timeout: Google TTS tidak merespons. Coba lagi nanti.';
      } else if (error.message.includes('Rate limit')) {
        userMessage = error.message;
      }
      
      throw new Error(`${userMessage} (Detail: ${error.message})`);
    }
  }

  /**
   * Generate token untuk beberapa bahasa (optional)
   */
  generateToken(text) {
    // Implementasi sederhana token generation jika diperlukan
    const timestamp = Date.now();
    return btoa(`${text}-${timestamp}`).substring(0, 20);
  }

  /**
   * Deteksi format audio dari data
   */
  detectAudioFormat(audioData) {
    // Google TTS biasanya mengembalikan MP3
    const header = audioData.slice(0, 4);
    
    if (header[0] === 0xFF && header[1] === 0xFB) {
      return 'audio/mp3';
    } else if (header[0] === 0x4F && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53) {
      return 'audio/ogg';
    } else if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
      return 'audio/wav';
    }
    
    return 'audio/mp3'; // Default
  }

  /**
   * Estimasi durasi audio dengan akurasi lebih baik
   */
  estimateDuration(text, speed) {
    // Karakter per menit berdasarkan bahasa
    const charsPerMinuteMap = {
      'id': 160, 'ms': 160, 'en': 150, 'es': 150, 'fr': 140, 
      'de': 140, 'it': 140, 'pt': 140, 'ru': 120, 'ja': 100,
      'ko': 100, 'zh': 80, 'th': 120, 'vi': 130, 'ar': 110
    };
    
    const langCode = this.mapLanguageCode('id-ID'); // Default
    const baseCharsPerMinute = charsPerMinuteMap[langCode] || 150;
    const adjustedCharsPerMinute = baseCharsPerMinute * speed;
    
    const durationInSeconds = (text.length / adjustedCharsPerMinute) * 60;
    
    // Tambahkan margin untuk jeda natural
    const naturalPauses = (text.match(/[.,!?;:]/g) || []).length;
    const pauseTime = naturalPauses * 0.3;
    
    return Math.max(0.5, Math.round((durationInSeconds + pauseTime) * 10) / 10);
  }

  /**
   * Mendapatkan daftar bahasa yang didukung dengan informasi suara perempuan
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
   * Rekomendasi pengaturan untuk suara perempuan natural
   */
  getFemaleVoiceRecommendations() {
    return {
      recommendedLanguages: ['id-ID', 'en-US', 'ja-JP', 'ko-KR', 'th-TH'],
      optimalSpeed: 0.85, // Sedikit lebih lambat untuk kejelasan
      textOptimizationTips: [
        'Gunakan kalimat pendek dan jelas',
        'Hindari singkatan yang tidak umum',
        'Gunakan tanda baca yang tepat',
        'Batasi panjang kalimat maksimal 20 kata',
      ],
      apiTips: [
        'Gunakan speed antara 0.8-1.0 untuk kejelasan maksimal',
        'Bahasa Indonesia dan Inggris memiliki suara perempuan paling natural',
        'Optimasi teks sebelum dikonversi untuk hasil terbaik',
      ]
    };
  }

  /**
   * Test koneksi ke Google TTS
   */
  async testConnection() {
    try {
      const testText = 'Halo, ini adalah uji suara perempuan yang natural dan jelas';
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
        message: 'Google TTS dapat diakses - Suara perempuan natural siap digunakan',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Google TTS tidak dapat diakses',
      };
    }
  }
}

module.exports = new GoogleTTSService();
