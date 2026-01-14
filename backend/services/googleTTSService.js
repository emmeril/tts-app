const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');

// Rate limiter untuk mencegah abuse
const rateLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT) || 100, // 100 request
  duration: parseInt(process.env.RATE_LIMIT_WINDOW) || 900, // per 15 menit
});

class GoogleTTSService {
  constructor() {
    this.baseUrl = 'https://translate.google.com/translate_tts';
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
      'id': 'id',           // Bahasa Indonesia
      'ms': 'ms',           // Bahasa Melayu
      'th': 'th',           // Thai
      'vi': 'vi',           // Vietnamese
      'ko': 'ko',           // Korean
      'ja': 'ja',           // Japanese
      'zh-CN': 'zh',        // Chinese Simplified
      'zh-TW': 'zh-TW',     // Chinese Traditional
      
      // Bahasa Eropa
      'en': 'en',
      'es': 'es',
      'fr': 'fr',
      'de': 'de',
      'it': 'it',
      'pt': 'pt',
      'ru': 'ru',
      'nl': 'nl',
      'pl': 'pl',
      'tr': 'tr',
      'el': 'el',
      'sv': 'sv',
      'da': 'da',
      'fi': 'fi',
      'no': 'no',
      'cs': 'cs',
      'hu': 'hu',
      'ro': 'ro',
      
      // Bahasa Lainnya
      'ar': 'ar',
      'he': 'iw',
      'hi': 'hi',
      'bn': 'bn',
      'fa': 'fa',
      'ur': 'ur',
    };
    
    // Jika kode panjang (seperti id-ID), ambil bagian pertama saja
    const langCode = language.split('-')[0];
    return languageMap[langCode] || languageMap[language] || 'en';
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
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.4) {
        truncated = truncated.substring(0, lastSpace);
      }
    }
    
    return truncated + (truncated.endsWith('.') ? '' : '.') + '..';
  }

  /**
   * Validasi input
   */
  validateInput(text, language) {
    const errors = [];
    
    if (!text || typeof text !== 'string') {
      errors.push('Text harus berupa string');
      return errors;
    }
    
    if (text.trim().length === 0) {
      errors.push('Text tidak boleh kosong atau hanya spasi');
    }
    
    if (text.length > 5000) {
      errors.push(`Text terlalu panjang (${text.length} karakter, maksimal 5000)`);
    }
    
    if (!language || language.trim().length === 0) {
      errors.push('Language tidak boleh kosong');
    }
    
    console.log(`Validation for text (${text.length} chars):`, errors.length > 0 ? errors : 'Valid');
    return errors;
  }

  /**
   * Konversi text ke speech menggunakan format default Google TTS
   */
  async convertTextToSpeech({ text, language = 'id', speed = 1.0 }) {
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
      
      // Parameter default Google TTS
      const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: langCode,
        client: 'tw-ob',
        q: truncatedText,
        ttsspeed: speed.toString(),
      });
      
      const ttsUrl = `${this.baseUrl}?${params.toString()}`;
      
      console.log(`[${new Date().toISOString()}] Google TTS Request: ${langCode}, Length: ${truncatedText.length}, Speed: ${speed}`);
      
      // Konfigurasi request
      const maxSizeMB = parseInt(process.env.MAX_AUDIO_SIZE_MB) || 2;
      const maxSizeBytes = maxSizeMB * 1024 * 1024;
      
      console.log(`Axios Config: maxContentLength=${maxSizeBytes} bytes (${maxSizeMB} MB)`);
      
      // Request ke Google TTS
      const response = await axios.get(ttsUrl, {
        responseType: 'arraybuffer',
        timeout: parseInt(process.env.REQUEST_TIMEOUT) || 40000,
        headers: {
          ...this.defaultHeaders,
          'Accept-Encoding': 'identity',
          'Accept': 'audio/mpeg, audio/*',
        },
        maxContentLength: maxSizeBytes,
        maxBodyLength: maxSizeBytes,
        maxRedirects: 5,
        decompress: true,
        validateStatus: function (status) {
          return status >= 200 && status < 300;
        }
      });
      
      console.log(`Response Status: ${response.status}, Content-Type: ${response.headers['content-type']}, Size: ${response.data?.length || 0} bytes`);
      
      // Validasi response
      if (!response.data || response.data.length === 0) {
        throw new Error('Google TTS tidak mengembalikan data audio');
      }
      
      if (response.data.length > maxSizeBytes) {
        console.warn(`Audio size ${response.data.length} bytes exceeds limit ${maxSizeBytes} bytes`);
      }
      
      // Cek format audio
      const audioFormat = 'audio/mp3'; // Google TTS default format
      
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
        format: audioFormat,
        truncated: truncatedText.length < text.length,
        optimized: optimizedText !== text,
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
      });
      
      let userMessage = 'Gagal mengonversi teks ke suara';
      
      if (error.response) {
        userMessage = `Google TTS menolak permintaan (Status: ${error.response.status})`;
      } else if (error.code === 'ECONNABORTED') {
        userMessage = 'Timeout: Google TTS tidak merespons';
      } else if (error.message.includes('Rate limit')) {
        userMessage = error.message;
      } else if (error.message.includes('maxContentLength')) {
        userMessage = 'Response audio terlalu besar';
      } else if (error.code === 'ENOTFOUND') {
        userMessage = 'Tidak dapat terhubung ke Google TTS';
      }
      
      throw new Error(`${userMessage} (${error.message})`);
    }
  }

  /**
   * Estimasi durasi audio
   */
  estimateDuration(text, speed) {
    const charsPerMinute = 150; // Default characters per minute
    const adjustedCharsPerMinute = charsPerMinute * speed;
    const durationInSeconds = (text.length / adjustedCharsPerMinute) * 60;
    return Math.max(0.5, Math.round(durationInSeconds * 10) / 10);
  }

  /**
   * Mendapatkan daftar bahasa yang didukung
   */
  getSupportedLanguages() {
    return [
      { code: 'id', name: 'Bahasa Indonesia', nativeName: 'Bahasa Indonesia' },
      { code: 'en', name: 'English', nativeName: 'English' },
      { code: 'es', name: 'Spanish', nativeName: 'Español' },
      { code: 'fr', name: 'French', nativeName: 'Français' },
      { code: 'de', name: 'German', nativeName: 'Deutsch' },
      { code: 'it', name: 'Italian', nativeName: 'Italiano' },
      { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
      { code: 'ru', name: 'Russian', nativeName: 'Русский' },
      { code: 'ja', name: 'Japanese', nativeName: '日本語' },
      { code: 'ko', name: 'Korean', nativeName: '한국어' },
      { code: 'zh', name: 'Chinese', nativeName: '中文' },
      { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
      { code: 'th', name: 'Thai', nativeName: 'ไทย' },
      { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
      { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
    ];
  }

  /**
   * Test koneksi ke Google TTS
   */
  async testConnection() {
    try {
      const testText = 'Halo';
      const testLang = 'id';
      
      const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: testLang,
        client: 'tw-ob',
        q: testText,
      });
      
      const testUrl = `${this.baseUrl}?${params.toString()}`;
      
      const response = await axios.head(testUrl, {
        timeout: 10000,
        headers: this.defaultHeaders,
      });
      
      return {
        success: true,
        status: response.status,
        message: 'Google TTS dapat diakses',
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