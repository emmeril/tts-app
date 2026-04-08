const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const MAX_TTS_TEXT_LENGTH = 5000;

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
    const normalizedLanguage = (language || '').trim();
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
    
    if (languageMap[normalizedLanguage]) {
      return languageMap[normalizedLanguage];
    }

    // Jika kode panjang (seperti id-ID), ambil bagian pertama saja.
    // Cek exact match dulu supaya kode khusus seperti zh-TW tidak salah dipetakan.
    const langCode = normalizedLanguage.split('-')[0];
    return languageMap[langCode] || 'en';
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
   * Google Translate TTS membatasi panjang request per chunk.
   * Pecah teks panjang menjadi beberapa bagian agar seluruh teks tetap diproses.
   */
  splitTextIntoChunks(text, maxLength = 200) {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks = [];
    let remaining = text.trim();

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = -1;
      const candidate = remaining.slice(0, maxLength + 1);
      const punctuationMatches = [...candidate.matchAll(/[.!?;:](?=\s|$)/g)];

      if (punctuationMatches.length > 0) {
        const lastMatch = punctuationMatches[punctuationMatches.length - 1];
        if (lastMatch.index >= Math.floor(maxLength * 0.5)) {
          splitIndex = lastMatch.index + 1;
        }
      }

      if (splitIndex === -1) {
        splitIndex = candidate.lastIndexOf(' ');
      }

      if (splitIndex <= 0) {
        splitIndex = maxLength;
      }

      const chunk = remaining.slice(0, splitIndex).trim();
      if (chunk) {
        chunks.push(chunk);
      }

      remaining = remaining.slice(splitIndex).trim();
    }

    return chunks;
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
    
    if (text.length > MAX_TTS_TEXT_LENGTH) {
      errors.push(`Text terlalu panjang (${text.length} karakter, maksimal ${MAX_TTS_TEXT_LENGTH})`);
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
      
      const textChunks = this.splitTextIntoChunks(optimizedText, 200);
      
      // Map language code
      const langCode = this.mapLanguageCode(language);
      
      // Konfigurasi request
      const maxSizeMB = parseInt(process.env.MAX_AUDIO_SIZE_MB) || 2;
      const maxSizeBytes = maxSizeMB * 1024 * 1024;

      console.log(
        `[${new Date().toISOString()}] Google TTS Request: ${langCode}, Chunks: ${textChunks.length}, Length: ${optimizedText.length}, Speed: ${speed}`
      );
      console.log(`Axios Config: maxContentLength=${maxSizeBytes} bytes (${maxSizeMB} MB)`);

      const audioBuffers = [];
      for (const [index, chunk] of textChunks.entries()) {
        const params = new URLSearchParams({
          ie: 'UTF-8',
          tl: langCode,
          client: 'tw-ob',
          q: chunk,
          ttsspeed: speed.toString(),
        });

        const ttsUrl = `${this.baseUrl}?${params.toString()}`;
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

        console.log(
          `Chunk ${index + 1}/${textChunks.length} status=${response.status} size=${response.data?.length || 0} bytes length=${chunk.length}`
        );

        if (!response.data || response.data.length === 0) {
          throw new Error(`Google TTS tidak mengembalikan data audio untuk chunk ${index + 1}`);
        }

        audioBuffers.push(Buffer.from(response.data));
      }

      const mergedAudioBuffer = Buffer.concat(audioBuffers);

      if (mergedAudioBuffer.length > maxSizeBytes * textChunks.length) {
        console.warn(
          `Audio size ${mergedAudioBuffer.length} bytes exceeds expected combined limit ${maxSizeBytes * textChunks.length} bytes`
        );
      }
      
      // Cek format audio
      const audioFormat = 'audio/mp3'; // Google TTS default format
      
      // Konversi ke base64
      const audioBase64 = mergedAudioBuffer.toString('base64');
      const audioDataUrl = `data:${audioFormat};base64,${audioBase64}`;
      
      // Hitung durasi estimasi
      const duration = this.estimateDuration(optimizedText, speed);
      
      return {
        success: true,
        audioUrl: audioDataUrl,
        duration: duration,
        textLength: optimizedText.length,
        originalTextLength: text.length,
        language: language,
        languageCode: langCode,
        speed: speed,
        format: audioFormat,
        truncated: false,
        optimized: optimizedText !== text,
        timestamp: new Date().toISOString(),
        audioSize: mergedAudioBuffer.length,
        chunkCount: textChunks.length
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
      
      const response = await axios.get(testUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          ...this.defaultHeaders,
          'Accept': 'audio/mpeg, audio/*',
        },
        maxContentLength: 256 * 1024,
        maxBodyLength: 256 * 1024,
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
