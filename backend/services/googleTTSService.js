const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');

// Rate limiter untuk mencegah abuse
const rateLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT) || 100,
  duration: parseInt(process.env.RATE_LIMIT_WINDOW) || 900,
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
    };
  }

  /**
   * Map kode bahasa - khusus untuk bahasa Indonesia
   */
  mapLanguageCode(language) {
    const languageMap = {
      'id-ID': 'id',
      'id': 'id',
      'en-US': 'en',
      'en': 'en',
      'ja-JP': 'ja',
      'ja': 'ja',
      'ko-KR': 'ko',
      'ko': 'ko',
    };
    
    return languageMap[language] || 'id';
  }

  /**
   * Optimasi teks untuk TTS Indonesia yang natural
   */
  optimizeTextForSpeech(text) {
    let optimized = text.trim();
    
    // Normalisasi spasi
    optimized = optimized.replace(/\s+/g, ' ');
    
    // Optimasi angka
    optimized = optimized.replace(/(\d+)/g, (match) => {
      const num = parseInt(match);
      if (num < 1000) {
        return match;
      }
      return match.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    });
    
    // Optimasi singkatan Indonesia yang umum
    const abbreviations = {
      'yg': 'yang',
      'dgn': 'dengan',
      'tdk': 'tidak',
      'utk': 'untuk',
      'sdh': 'sudah',
      'blm': 'belum',
      'krn': 'karena',
      'bgmn': 'bagaimana',
      'dll': 'dan lain-lain',
      'dsb': 'dan seterusnya',
      'tsb': 'tersebut',
      'dpt': 'dapat',
      'pd': 'pada',
      'org': 'orang',
      'spt': 'seperti',
      'bbrp': 'beberapa',
      'bnyk': 'banyak',
      'skrg': 'sekarang',
      'tgl': 'tanggal',
      'bln': 'bulan',
      'thn': 'tahun',
      'jl': 'jalan',
      'no': 'nomor',
      'dokter': 'dokter',
      'dr.': 'dokter',
      'Dr.': 'Dokter',
      'kg': 'kilogram',
      'km': 'kilometer',
      'cm': 'sentimeter',
      'mm': 'milimeter',
      'Rp': 'Rupiah',
      'rp': 'rupiah',
      'jam': 'jam',
      'wib': 'Waktu Indonesia Barat',
      'wit': 'Waktu Indonesia Timur',
      'wita': 'Waktu Indonesia Tengah',
    };
    
    // Optimasi dengan case insensitive
    Object.keys(abbreviations).forEach(abbr => {
      const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
      optimized = optimized.replace(regex, (match) => {
        const replacement = abbreviations[abbr.toLowerCase()];
        return match === match.toUpperCase() ? replacement.toUpperCase() : 
               match[0] === match[0].toUpperCase() ? 
               replacement.charAt(0).toUpperCase() + replacement.slice(1) : 
               replacement;
      });
    });
    
    // Tambahkan jeda natural
    optimized = optimized.replace(/([.,!?;:])\s+/g, '$1<pause>');
    optimized = optimized.replace(/(\sdan\s|\satau\s|\stetapi\s|\snamun\s)/g, '$1<pause>');
    
    // Kapitalisasi nama bulan dan hari
    const months = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];
    const days = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];
    
    months.forEach(month => {
      const regex = new RegExp(`\\b${month}\\b`, 'gi');
      optimized = optimized.replace(regex, month.charAt(0).toUpperCase() + month.slice(1));
    });
    
    days.forEach(day => {
      const regex = new RegExp(`\\b${day}\\b`, 'gi');
      optimized = optimized.replace(regex, day.charAt(0).toUpperCase() + day.slice(1));
    });
    
    return optimized;
  }

  /**
   * Truncate text dengan memperhatikan kalimat Indonesia
   */
  truncateText(text, maxLength = 180) {
    if (text.length <= maxLength) return text;
    
    let truncated = text.substring(0, maxLength);
    
    // Cari akhir kalimat yang baik
    const sentenceEnd = truncated.lastIndexOf('. ');
    const questionEnd = truncated.lastIndexOf('? ');
    const exclamationEnd = truncated.lastIndexOf('! ');
    
    let bestEnd = Math.max(sentenceEnd, questionEnd, exclamationEnd);
    
    // Jika tidak menemukan, cari koma atau kata sambung
    if (bestEnd < maxLength * 0.5) {
      const commaEnd = truncated.lastIndexOf(', ');
      const semicolonEnd = truncated.lastIndexOf('; ');
      bestEnd = Math.max(commaEnd, semicolonEnd);
      
      if (bestEnd < maxLength * 0.4) {
        const spaceEnd = truncated.lastIndexOf(' ');
        if (spaceEnd > maxLength * 0.3) {
          bestEnd = spaceEnd;
        }
      }
    }
    
    if (bestEnd > 0) {
      truncated = truncated.substring(0, bestEnd + 1);
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
      errors.push('Text tidak boleh kosong');
    }
    
    if (text.length > 2000) {
      errors.push(`Text terlalu panjang (${text.length} karakter, maksimal 2000)`);
    }
    
    if (!language || language.trim().length === 0) {
      errors.push('Language tidak boleh kosong');
    }
    
    return errors;
  }

  /**
   * Konversi text ke speech - SETTING TERBAIK untuk Indonesia
   */
  async convertTextToSpeech({ text, language = 'id', speed = 1.0, pitch = 1.0 }) {
    try {
      // Validasi input
      const validationErrors = this.validateInput(text, language);
      if (validationErrors.length > 0) {
        throw new Error(validationErrors.join(', '));
      }

      // Rate limiting
      try {
        await rateLimiter.consume('google-tts');
      } catch (rateLimitError) {
        throw new Error('Terlalu banyak permintaan. Silakan tunggu beberapa saat.');
      }

      // Optimasi teks
      const optimizedText = this.optimizeTextForSpeech(text);
      
      // Truncate jika perlu
      const finalText = this.truncateText(optimizedText, 180);
      
      // Map language code
      const langCode = this.mapLanguageCode(language);
      
      // **SETTING TERBAIK untuk suara natural Indonesia:**
      // Gunakan client 'gtx' bukan 'tw-ob'
      // Speed 1.0 (normal) lebih natural daripada lambat
      // Tambahkan parameter dn untuk kualitas lebih baik
      
      const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: langCode,
        client: 'gtx',  // **PENTING: gtx lebih baik untuk Indonesia**
        q: finalText,
        ttsspeed: '1.0',  // Fixed speed 1.0 (paling natural)
        textlen: finalText.length.toString(),
        idx: '0',
        total: '1',
        prev: 'input',
        dn: 'translate.google.com',  // **PENTING: Parameter untuk kualitas baik**
      });

      // Untuk Indonesia, gunakan token khusus
      if (langCode === 'id') {
        params.append('tk', this.generateIndonesianToken(finalText));
      }
      
      const ttsUrl = `${this.baseUrl}?${params.toString()}`;
      
      console.log(`Google TTS Request: ${langCode}, Length: ${finalText.length}, Speed: ${speed}`);
      
      // Request ke Google TTS dengan timeout pendek
      const response = await axios.get(ttsUrl, {
        responseType: 'arraybuffer',
        timeout: 15000, // 15 detik cukup
        headers: {
          ...this.defaultHeaders,
          'Accept-Encoding': 'identity',
          'Accept': 'audio/mpeg, audio/*',
        },
        maxContentLength: 1024 * 1024, // 1MB max
        maxBodyLength: 1024 * 1024,
      });
      
      // Validasi response
      if (!response.data || response.data.length === 0) {
        throw new Error('Tidak mendapatkan data audio');
      }
      
      // Deteksi format
      const audioFormat = 'audio/mp3'; // Google selalu return MP3
      
      // Konversi ke base64
      const audioBase64 = Buffer.from(response.data).toString('base64');
      const audioDataUrl = `data:${audioFormat};base64,${audioBase64}`;
      
      // Estimasi durasi
      const duration = this.estimateDuration(finalText);
      
      return {
        success: true,
        audioUrl: audioDataUrl,
        duration: duration,
        textLength: finalText.length,
        originalTextLength: text.length,
        language: language,
        languageCode: langCode,
        speed: 1.0,
        format: audioFormat,
        voiceGender: 'female',
        voiceQuality: 'natural',
        timestamp: new Date().toISOString(),
        audioSize: response.data.length
      };
      
    } catch (error) {
      console.error('Google TTS Error:', error.message);
      
      let userMessage = 'Gagal mengonversi teks ke suara';
      
      if (error.response) {
        if (error.response.status === 429) {
          userMessage = 'Terlalu banyak permintaan. Coba lagi nanti.';
        } else if (error.response.status === 404) {
          userMessage = 'Layanan TTS tidak ditemukan. Periksa URL.';
        }
      } else if (error.code === 'ECONNABORTED') {
        userMessage = 'Timeout. Coba lagi atau periksa koneksi.';
      } else if (error.message.includes('Rate limit')) {
        userMessage = 'Terlalu banyak permintaan. Tunggu 15 menit.';
      }
      
      throw new Error(`${userMessage} (${error.message})`);
    }
  }

  /**
   * Generate token khusus untuk bahasa Indonesia
   */
  generateIndonesianToken(text) {
    // Simple token untuk Indonesia
    const timestamp = Math.floor(Date.now() / 1000 / 3600);
    const hash = text.length * 12345 + timestamp;
    return hash.toString(16).substring(0, 8);
  }

  /**
   * Estimasi durasi untuk bahasa Indonesia
   */
  estimateDuration(text) {
    const words = text.split(/\s+/).length;
    const durationMinutes = words / 150; // 150 kata per menit untuk Indonesia
    const durationSeconds = Math.round(durationMinutes * 60 * 100) / 100;
    
    // Minimum 1 detik, maksimum 30 detik
    return Math.max(1, Math.min(30, durationSeconds));
  }

  /**
   * Daftar bahasa dengan fokus Indonesia
   */
  getSupportedLanguages() {
    return [
      { 
        code: 'id', 
        name: 'Bahasa Indonesia', 
        nativeName: 'Bahasa Indonesia', 
        voiceGender: 'female',
        recommendedSpeed: 1.0,
        quality: 'natural',
        description: 'Suara wanita Indonesia natural - Rekomendasi terbaik'
      },
      { 
        code: 'en', 
        name: 'English', 
        nativeName: 'English', 
        voiceGender: 'female',
        recommendedSpeed: 1.0,
        quality: 'good',
        description: 'Suara wanita Inggris'
      },
      { 
        code: 'ja', 
        name: 'Japanese', 
        nativeName: '日本語', 
        voiceGender: 'female',
        recommendedSpeed: 0.9,
        quality: 'good',
        description: 'Suara wanita Jepang'
      },
    ];
  }

  /**
   * Rekomendasi setting terbaik untuk Indonesia
   */
  getBestSettings() {
    return {
      indonesian: {
        language: 'id',
        speed: 1.0,
        maxTextLength: 180,
        client: 'gtx',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://translate.google.com/'
        },
        tips: [
          'Gunakan kalimat pendek (maks 180 karakter)',
          'Hindari singkatan tidak standar',
          'Gunakan tanda baca dengan benar',
          'Speed 1.0 (normal) paling natural',
          'Client "gtx" lebih stabil untuk Indonesia'
        ]
      }
    };
  }

  /**
   * Test koneksi dengan teks Indonesia singkat
   */
  async testConnection() {
    try {
      const testText = 'Halo, selamat pagi. Apa kabar?';
      const testLang = 'id';
      
      const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: testLang,
        client: 'gtx',
        q: testText,
        ttsspeed: '1.0',
      });
      
      const testUrl = `${this.baseUrl}?${params.toString()}`;
      
      const response = await axios.head(testUrl, {
        timeout: 10000,
        headers: this.defaultHeaders,
      });
      
      return {
        success: true,
        status: response.status,
        message: 'Google TTS berjalan normal',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Tidak dapat mengakses Google TTS',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Contoh penggunaan yang direkomendasikan
   */
  getUsageExample() {
    return {
      example: {
        text: 'Selamat pagi semuanya. Hari ini cuaca cerah dan menyenangkan.',
        language: 'id',
        settings: {
          speed: 1.0,
          maxLength: 180,
          client: 'gtx'
        },
        expectedResult: 'Audio MP3 dengan suara wanita Indonesia yang natural'
      },
      bestPractices: [
        '1. Gunakan bahasa Indonesia yang baku',
        '2. Maksimal 180 karakter per request',
        '3. Speed tetap 1.0 (jangan diubah)',
        '4. Client selalu "gtx"',
        '5. Tambahkan tanda baca untuk jeda natural'
      ]
    };
  }
}

module.exports = new GoogleTTSService();
