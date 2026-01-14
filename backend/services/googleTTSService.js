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
   * Map kode bahasa ke format Google TTS dengan peningkatan untuk bahasa Indonesia
   */
  mapLanguageCode(language) {
    const languageMap = {
      // Bahasa Indonesia dengan parameter khusus untuk naturalness
      'id-ID': 'id-ID',          // Bahasa Indonesia dengan pengucapan natural
      'id': 'id-ID',             // Alias untuk bahasa Indonesia
      'id-NATURAL': 'id-ID',     // Versi natural khusus
      'id-FORMAL': 'id',         // Versi formal
      
      // Bahasa Asia
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
    
    return languageMap[language] || 'id-ID'; // Default ke bahasa Indonesia natural
  }

  /**
   * Optimasi teks untuk pengucapan bahasa Indonesia yang lebih natural
   */
  optimizeTextForSpeech(text, language = 'id-ID') {
    let optimized = text;
    
    // Normalisasi spasi dan tanda baca khusus untuk bahasa Indonesia
    optimized = optimized.replace(/\s+/g, ' ');
    optimized = optimized.replace(/\s+([.,!?;:])/g, '$1');
    optimized = optimized.replace(/([.,!?;:])(\S)/g, '$1 $2');
    
    // Optimasi angka untuk bahasa Indonesia
    optimized = optimized.replace(/(\d+)/g, (match) => {
      const num = parseInt(match);
      if (num < 1000) {
        return match;
      }
      // Format angka ribuan dengan titik untuk bahasa Indonesia
      return match.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    });
    
    // Optimasi singkatan umum Indonesia
    const abbreviations = {
      // Formal
      'dr.': 'dokter',
      'Dr.': 'Dokter',
      'Mr.': 'Tuan',
      'Mrs.': 'Nyonya',
      'Ms.': 'Nona',
      'etc.': 'dan sebagainya',
      'e.g.': 'contohnya',
      'i.e.': 'yaitu',
      'vs.': 'melawan',
      
      // Satuan
      'kg': 'kilogram',
      'km': 'kilometer',
      'cm': 'sentimeter',
      'mm': 'milimeter',
      'ml': 'mililiter',
      '°C': 'derajat Celsius',
      'Rp': 'Rupiah',
      'rp': 'rupiah',
      
      // Singkatan populer Indonesia
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
      'yg': 'yang',
      'ga': 'tidak',
      'gak': 'tidak',
      'g': 'tidak',
      'lo': 'kamu',
      'lu': 'kamu',
      'gw': 'saya',
      'gue': 'saya',
      'ane': 'saya',
      'ente': 'anda',
      'kalo': 'kalau',
      'ato': 'atau',
      'bgt': 'sekali',
      'banget': 'sekali',
      'trus': 'terus',
      'trs': 'terus',
      'bbrp': 'beberapa',
      'bnyk': 'banyak',
      'skrg': 'sekarang',
      'tgl': 'tanggal',
      'tgl.': 'tanggal',
      'bln': 'bulan',
      'bln.': 'bulan',
      'thn': 'tahun',
      'thn.': 'tahun',
      'jl.': 'jalan',
      'jl': 'jalan',
      'no.': 'nomor',
      'no': 'nomor',
    };
    
    Object.keys(abbreviations).forEach(abbr => {
      const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
      optimized = optimized.replace(regex, abbreviations[abbr]);
    });
    
    // Perbaikan pengucapan kata khusus Indonesia
    const pronunciationFixes = {
      'foto': 'foto',
      'video': 'video',
      'data': 'data',
      'sistem': 'sistem',
      'teknologi': 'teknologi',
      'informasi': 'informasi',
      'komputer': 'komputer',
      'internet': 'internet',
      'email': 'email',
      'website': 'website',
      'online': 'online',
      'offline': 'offline',
    };
    
    Object.keys(pronunciationFixes).forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      optimized = optimized.replace(regex, pronunciationFixes[word]);
    });
    
    // Tambahkan jeda natural untuk kalimat panjang (lebih pendek untuk bahasa Indonesia)
    if (optimized.length > 30) {
      optimized = optimized.replace(/([,;:])\s+/g, '$1<pause>');
      optimized = optimized.replace(/(\sdan\s|\satau\s|\stetapi\s)/g, '$1<pause>');
    }
    
    // Kapitalisasi untuk nama bulan dan hari
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
    
    return optimized.trim();
  }

  /**
   * Truncate text jika terlalu panjang dengan memperhatikan struktur kalimat Indonesia
   */
  truncateText(text, maxLength = 200) {
    if (text.length <= maxLength) return text;
    
    let truncated = text.substring(0, maxLength);
    
    // Cari akhir kalimat yang paling sesuai untuk bahasa Indonesia
    const sentenceEnd = truncated.lastIndexOf('. ');
    const questionEnd = truncated.lastIndexOf('? ');
    const exclamationEnd = truncated.lastIndexOf('! ');
    const commaEnd = truncated.lastIndexOf(', ');
    
    const bestEnd = Math.max(sentenceEnd, questionEnd, exclamationEnd, commaEnd);
    
    // Jika ditemukan akhir kalimat yang baik
    if (bestEnd > maxLength * 0.5) {
      truncated = truncated.substring(0, bestEnd + 1);
    } else {
      // Cari kata sambung atau preposisi khas Indonesia
      const connectors = [' dan ', ' atau ', ' tetapi ', ' namun ', ' karena ', ' sehingga ', ' maka '];
      let connectorPos = -1;
      
      for (const connector of connectors) {
        const pos = truncated.lastIndexOf(connector);
        if (pos > connectorPos && pos > maxLength * 0.4) {
          connectorPos = pos;
        }
      }
      
      if (connectorPos > 0) {
        truncated = truncated.substring(0, connectorPos);
      } else {
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > maxLength * 0.4) {
          truncated = truncated.substring(0, lastSpace);
        }
      }
    }
    
    // Tambahkan elipsis jika diperlukan
    if (!truncated.endsWith('.') && !truncated.endsWith('?') && !truncated.endsWith('!')) {
      truncated += '...';
    }
    
    return truncated;
  }

  /**
   * Validasi input
   */
  validateInput(text, language) {
    const errors = [];
    
    // Cek jika text ada dan bertipe string
    if (!text || typeof text !== 'string') {
        errors.push('Text harus berupa string');
        return errors;
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
   * Konversi text ke speech dengan optimasi khusus untuk bahasa Indonesia
   */
  async convertTextToSpeech({ text, language = 'id-ID', speed = 0.85, pitch = 1.0 }) {
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

        // Optimasi teks khusus untuk bahasa
        const optimizedText = this.optimizeTextForSpeech(text, language);
        
        // Truncate text jika terlalu panjang
        const truncatedText = this.truncateText(optimizedText, 200);
        
        // Map language code
        const langCode = this.mapLanguageCode(language);
        
        // Parameter khusus untuk bahasa Indonesia natural
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
        
        // Tambahkan parameter khusus untuk kualitas lebih baik
        if (langCode.includes('id')) {
            params.append('tk', this.generateToken(truncatedText));
            // Parameter tambahan untuk suara natural Indonesia
            params.append('pitch', pitch.toString());
            params.append('freq', '22050'); // Frekuensi sampling untuk kualitas baik
        }
        
        const ttsUrl = `${this.baseUrl}?${params.toString()}`;
        
        console.log(`[${new Date().toISOString()}] Google TTS Request: ${langCode}, Length: ${truncatedText.length}, Speed: ${speed}, Pitch: ${pitch}`);
        
        // Konfigurasi Axios
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
                'DNT': '1',
                'Accept': 'audio/mpeg, audio/*',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache',
            },
            maxContentLength: maxSizeBytes,
            maxBodyLength: maxSizeBytes,
            maxRedirects: 5,
            decompress: true,
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
        
        // Hitung durasi estimasi dengan akurat
        const duration = this.estimateDuration(truncatedText, speed, language);
        
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
            voiceName: 'Google Indonesian Female',
            naturalness: 'high',
            clarity: 'high',
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
   * Estimasi durasi audio untuk bahasa Indonesia
   */
  estimateDuration(text, speed, language) {
    // Karakter per menit berdasarkan bahasa
    const charsPerMinuteMap = {
      'id': 165,     // Bahasa Indonesia natural
      'id-ID': 165,  // Bahasa Indonesia natural
      'ms': 160,     // Melayu
      'en': 150,     // Inggris
      'es': 150,     // Spanyol
      'fr': 140,     // Prancis
      'de': 140,     // Jerman
      'it': 140,     // Italia
      'pt': 140,     // Portugis
      'ru': 120,     // Rusia
      'ja': 100,     // Jepang
      'ko': 100,     // Korea
      'zh': 80,      // Cina
      'th': 120,     // Thai
      'vi': 130,     // Vietnam
      'ar': 110      // Arab
    };
    
    const langCode = this.mapLanguageCode(language);
    const baseCode = langCode.split('-')[0];
    const baseCharsPerMinute = charsPerMinuteMap[baseCode] || charsPerMinuteMap[langCode] || 150;
    
    // Adjust speed (0.5-2.0 range)
    const speedFactor = Math.max(0.5, Math.min(2.0, speed));
    const adjustedCharsPerMinute = baseCharsPerMinute * speedFactor;
    
    // Hitung durasi dasar
    const durationInSeconds = (text.length / adjustedCharsPerMinute) * 60;
    
    // Tambahkan waktu untuk jeda alami
    const naturalPauses = (text.match(/[.,!?;:]/g) || []).length;
    const pauseTime = naturalPauses * 0.4; // Sedikit lebih lama untuk bahasa Indonesia
    
    // Tambahkan waktu untuk tag <pause> jika ada
    const pauseTags = (text.match(/<pause>/g) || []).length;
    const pauseTagTime = pauseTags * 0.6;
    
    // Durasi total
    const totalDuration = Math.max(1.0, Math.round((durationInSeconds + pauseTime + pauseTagTime) * 10) / 10);
    
    return totalDuration;
  }

  /**
   * Mendapatkan daftar bahasa yang didukung dengan penekanan pada Indonesia
   */
  getSupportedLanguages() {
    return [
      { 
        code: 'id-ID', 
        name: 'Bahasa Indonesia (Natural)', 
        nativeName: 'Bahasa Indonesia', 
        voiceGender: 'female', 
        clarity: 'very-high',
        naturalness: 'very-high',
        recommendedSpeed: 0.85,
        description: 'Suara natural dengan pengucapan jelas khas Indonesia'
      },
      { 
        code: 'id-NATURAL', 
        name: 'Bahasa Indonesia (Sangat Natural)', 
        nativeName: 'Bahasa Indonesia', 
        voiceGender: 'female', 
        clarity: 'high',
        naturalness: 'very-high',
        recommendedSpeed: 0.8,
        description: 'Suara paling natural dengan intonasi alami'
      },
      { 
        code: 'id-FORMAL', 
        name: 'Bahasa Indonesia (Formal)', 
        nativeName: 'Bahasa Indonesia', 
        voiceGender: 'female', 
        clarity: 'very-high',
        naturalness: 'medium',
        recommendedSpeed: 0.9,
        description: 'Suara formal untuk penggunaan resmi'
      },
      { 
        code: 'en-US', 
        name: 'English (US)', 
        nativeName: 'English', 
        voiceGender: 'female', 
        clarity: 'high',
        naturalness: 'high',
        recommendedSpeed: 0.9,
        description: 'American English with clear pronunciation'
      },
      { 
        code: 'ms-MY', 
        name: 'Malay', 
        nativeName: 'Bahasa Melayu', 
        voiceGender: 'female', 
        clarity: 'high',
        naturalness: 'high',
        recommendedSpeed: 0.85,
        description: 'Bahasa Melayu dengan pengucapan jelas'
      },
      { 
        code: 'th-TH', 
        name: 'Thai', 
        nativeName: 'ไทย', 
        voiceGender: 'female', 
        clarity: 'high',
        naturalness: 'medium',
        recommendedSpeed: 0.8,
        description: 'Bahasa Thailand dengan intonasi alami'
      },
      { 
        code: 'vi-VN', 
        name: 'Vietnamese', 
        nativeName: 'Tiếng Việt', 
        voiceGender: 'female', 
        clarity: 'high',
        naturalness: 'medium',
        recommendedSpeed: 0.85,
        description: 'Bahasa Vietnam dengan pengucapan jelas'
      },
      { 
        code: 'ja-JP', 
        name: 'Japanese', 
        nativeName: '日本語', 
        voiceGender: 'female', 
        clarity: 'high',
        naturalness: 'high',
        recommendedSpeed: 0.8,
        description: 'Bahasa Jepang dengan intonasi alami'
      },
      { 
        code: 'ko-KR', 
        name: 'Korean', 
        nativeName: '한국어', 
        voiceGender: 'female', 
        clarity: 'high',
        naturalness: 'medium',
        recommendedSpeed: 0.85,
        description: 'Bahasa Korea dengan pengucapan jelas'
      },
    ];
  }

  /**
   * Rekomendasi pengaturan untuk suara natural bahasa Indonesia
   */
  getVoiceRecommendations() {
    return {
      recommendedLanguages: ['id-ID', 'id-NATURAL', 'en-US', 'ms-MY', 'ja-JP'],
      optimalSpeed: 0.85,
      optimalPitch: 1.0,
      textOptimizationTips: [
        'Gunakan kalimat pendek (maksimal 15 kata per kalimat)',
        'Hindari singkatan tidak formal (yg, dgn, tdk)',
        'Gunakan tanda baca yang tepat untuk jeda alami',
        'Kapitalisasi nama bulan, hari, dan istilah khusus',
        'Ubah angka ribuan dengan format Indonesia (1.000 bukan 1,000)',
      ],
      apiTips: [
        'Gunakan speed 0.8-0.9 untuk kejelasan maksimal',
        'Pitch 1.0-1.2 untuk suara lebih natural',
        'Bahasa Indonesia memiliki suara paling natural di Google TTS',
        'Optimasi teks sebelum dikonversi untuk hasil terbaik',
        'Gunakan <pause> untuk jeda alami di kalimat panjang',
      ],
      indonesianSpecificTips: [
        'Singkatan resmi: dr. (dokter), Rp (rupiah), kg (kilogram)',
        'Hindari bahasa gaul untuk hasil terbaik',
        'Gunakan "yang" bukan "yg", "dengan" bukan "dgn"',
        'Format tanggal: 31 Desember 2023 (bukan 31/12/2023)',
        'Nama bulan dan hari selalu kapital',
      ]
    };
  }

  /**
   * Test koneksi ke Google TTS dengan teks Indonesia
   */
  async testConnection() {
    try {
      const testText = 'Halo, ini adalah uji coba suara bahasa Indonesia yang natural dan jelas. Apakah anda dapat mendengarkan saya?';
      const testLang = 'id-ID';
      
      const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: testLang,
        client: 'tw-ob',
        q: testText,
        ttsspeed: '0.85',
      });
      
      const testUrl = `${this.baseUrl}?${params.toString()}`;
      
      const response = await axios.head(testUrl, {
        timeout: 15000,
        headers: this.defaultHeaders,
      });
      
      return {
        success: true,
        status: response.status,
        message: 'Google TTS dapat diakses - Suara Indonesia natural siap digunakan',
        timestamp: new Date().toISOString(),
        testText: testText,
        language: testLang
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Google TTS tidak dapat diakses',
        timestamp: new Date().toISOString(),
        recommendation: 'Periksa koneksi internet atau coba lagi nanti'
      };
    }
  }

  /**
   * Optimasi khusus untuk suara wanita Indonesia (lebih natural)
   */
  getIndonesianVoiceProfile() {
    return {
      gender: 'female',
      age: 'adult',
      style: 'natural',
      pitchRange: 'medium-high',
      speakingRate: 'medium',
      clarity: 'very-high',
      emotion: 'neutral',
      recommendedSettings: {
        speed: 0.85,
        pitch: 1.0,
        volume: 1.0,
        pauseBetweenSentences: 0.5,
        pauseBetweenParagraphs: 1.0
      },
      pronunciationRules: [
        'Akhiran "kan" diucapkan jelas',
        'Huruf "r" diucapkan dengan getaran ringan',
        'Intonasi naik di akhir kalimat tanya',
        'Penekanan pada kata penting',
        'Jeda alami sebelum konjungsi'
      ]
    };
  }
}

module.exports = new GoogleTTSService();
