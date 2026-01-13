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
      'id': 'id',             // Bahasa Indonesia (alternative)
      'ms-MY': 'ms',          // Bahasa Melayu
      'th-TH': 'th',          // Thai
      'vi-VN': 'vi',          // Vietnamese
      'ko-KR': 'ko',          // Korean
      'ja-JP': 'ja',          // Japanese
      'zh-CN': 'zh-CN',       // Chinese Simplified
      'zh-TW': 'zh-TW',       // Chinese Traditional
      
      // Bahasa Eropa
      'en-US': 'en',          // English US
      'en-GB': 'en-GB',       // English UK
      'es-ES': 'es',          // Spanish
      'fr-FR': 'fr',          // French
      'de-DE': 'de',          // German
      'it-IT': 'it',          // Italian
      'pt-BR': 'pt',          // Portuguese Brazil
      'pt-PT': 'pt-PT',       // Portuguese Portugal
      'ru-RU': 'ru',          // Russian
      'nl-NL': 'nl',          // Dutch
      'pl-PL': 'pl',          // Polish
      'tr-TR': 'tr',          // Turkish
      'el-GR': 'el',          // Greek
      'sv-SE': 'sv',          // Swedish
      'da-DK': 'da',          // Danish
      'fi-FI': 'fi',          // Finnish
      'no-NO': 'no',          // Norwegian
      'cs-CZ': 'cs',          // Czech
      'hu-HU': 'hu',          // Hungarian
      'ro-RO': 'ro',          // Romanian
      
      // Bahasa Lainnya
      'ar-SA': 'ar',          // Arabic
      'he-IL': 'iw',          // Hebrew
      'hi-IN': 'hi',          // Hindi
      'bn-BD': 'bn',          // Bengali
      'fa-IR': 'fa',          // Persian
      'ur-PK': 'ur',          // Urdu
    };
    
    return languageMap[language] || 'en';
  }

  /**
   * Truncate text jika terlalu panjang
   */
  truncateText(text, maxLength = 200) {
    if (text.length <= maxLength) return text;
    
    // Cari titik potong yang natural (spasi atau punctuation)
    let truncated = text.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    const lastPunct = Math.max(
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?'),
      truncated.lastIndexOf(',')
    );
    
    const cutIndex = Math.max(lastPunct, lastSpace);
    if (cutIndex > maxLength * 0.7) { // Minimal potong 70% dari maxLength
      truncated = truncated.substring(0, cutIndex + 1);
    }
    
    return truncated + '...';
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
   * Konversi text ke speech menggunakan Google TTS
   */
  async convertTextToSpeech({ text, language = 'id-ID', speed = 1.0 }) {
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

      // Truncate text jika terlalu panjang
      const truncatedText = this.truncateText(text, 200);
      
      // Map language code
      const langCode = this.mapLanguageCode(language);
      
      // Buat URL untuk Google TTS
      const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: langCode,
        client: 'tw-ob',
        q: truncatedText,
        ttsspeed: speed.toString(),
      });
      
      const ttsUrl = `${this.baseUrl}?${params.toString()}`;
      
      console.log(`Google TTS Request: ${langCode}, Length: ${truncatedText.length}`);
      
      // Request ke Google TTS
      const response = await axios.get(ttsUrl, {
        responseType: 'arraybuffer',
        timeout: parseInt(process.env.REQUEST_TIMEOUT) || 30000,
        headers: this.defaultHeaders,
        maxContentLength: 1024 * 1024, // 1MB max
        maxBodyLength: 1024 * 1024, // 1MB max
      });
      
      // Validasi response
      if (!response.data || response.data.length === 0) {
        throw new Error('Google TTS tidak mengembalikan data audio');
      }
      
      // Konversi ke base64
      const audioBase64 = Buffer.from(response.data).toString('base64');
      const audioDataUrl = `data:audio/mp3;base64,${audioBase64}`;
      
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
        format: 'audio/mp3',
        truncated: truncatedText.length < text.length,
      };
      
    } catch (error) {
      console.error('Google TTS Service Error:', error.message);
      
      // Berikan error message yang lebih user-friendly
      let userMessage = 'Gagal mengonversi teks ke suara';
      
      if (error.response) {
        // Error dari Google TTS
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
   * Estimasi durasi audio berdasarkan panjang teks dan kecepatan
   */
  estimateDuration(text, speed) {
    // Rata-rata: 150 karakter = 1 menit (kecepatan normal)
    const charsPerMinute = 150 * speed;
    const durationInSeconds = (text.length / charsPerMinute) * 60;
    
    // Round ke 0.1 detik
    return Math.max(0.5, Math.round(durationInSeconds * 10) / 10);
  }

  /**
   * Mendapatkan daftar bahasa yang didukung
   */
  getSupportedLanguages() {
    return [
      { code: 'id-ID', name: 'Bahasa Indonesia', nativeName: 'Bahasa Indonesia' },
      { code: 'en-US', name: 'English (US)', nativeName: 'English' },
      { code: 'en-GB', name: 'English (UK)', nativeName: 'English' },
      { code: 'es-ES', name: 'Spanish', nativeName: 'Español' },
      { code: 'fr-FR', name: 'French', nativeName: 'Français' },
      { code: 'de-DE', name: 'German', nativeName: 'Deutsch' },
      { code: 'it-IT', name: 'Italian', nativeName: 'Italiano' },
      { code: 'pt-BR', name: 'Portuguese (BR)', nativeName: 'Português' },
      { code: 'ru-RU', name: 'Russian', nativeName: 'Русский' },
      { code: 'ja-JP', name: 'Japanese', nativeName: '日本語' },
      { code: 'ko-KR', name: 'Korean', nativeName: '한국어' },
      { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '中文 (简体)' },
      { code: 'ar-SA', name: 'Arabic', nativeName: 'العربية' },
      { code: 'hi-IN', name: 'Hindi', nativeName: 'हिन्दी' },
      { code: 'th-TH', name: 'Thai', nativeName: 'ไทย' },
      { code: 'vi-VN', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
      { code: 'ms-MY', name: 'Malay', nativeName: 'Bahasa Melayu' },
    ];
  }

  /**
   * Test koneksi ke Google TTS
   */
  async testConnection() {
    try {
      const testText = 'Hello';
      const testLang = 'en';
      
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