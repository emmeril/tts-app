const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');

// Rate limiter untuk mencegah abuse
const rateLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT) || 100,
  duration: parseInt(process.env.RATE_LIMIT_WINDOW) || 900,
});

class GoogleTTSService {
  constructor() {
    this.baseUrl = process.env.GOOGLE_TTS_API || 'https://translate.google.com/translate_tts';
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Referer': 'https://translate.google.com/',
      'Origin': 'https://translate.google.com',
    };
  }

  /**
   * Map kode bahasa dengan fokus pada Indonesia
   */
  mapLanguageCode(language) {
    const languageMap = {
      // Bahasa Indonesia dengan berbagai variasi
      'id-ID': 'id-ID',          // Bahasa Indonesia standar
      'id': 'id-ID',
      'id-JAKARTA': 'id-ID',     // Dialek Jakarta
      'id-SUNDA': 'su',          // Campuran Sunda
      'id-JAWA': 'jw',           // Campuran Jawa
      
      // Bahasa daerah Indonesia
      'su-ID': 'su',             // Sunda
      'jw-ID': 'jw',             // Jawa
      'ms-ID': 'ms',             // Melayu Indonesia
      
      // Bahasa Asia lainnya
      'ms-MY': 'ms',
      'th-TH': 'th',
      'vi-VN': 'vi',
      
      // Bahasa internasional
      'en-US': 'en-US',
      'en-GB': 'en-GB',
    };
    
    return languageMap[language] || 'id-ID';
  }

  /**
   * Optimasi khusus untuk pelafalan Indonesia yang natural
   */
  optimizeTextForSpeech(text, language = 'id-ID') {
    let optimized = text.trim();
    
    // Normalisasi untuk bahasa Indonesia
    optimized = this.normalizeIndonesianText(optimized);
    
    // Konversi angka ke kata (terutama untuk 0-12)
    optimized = this.convertNumbersToWords(optimized);
    
    // Normalisasi singkatan Indonesia
    optimized = this.normalizeIndonesianAbbreviations(optimized);
    
    // Penyesuaian untuk pelafalan natural
    optimized = this.adjustForNaturalPronunciation(optimized, language);
    
    // Tambahkan jeda alami untuk intonasi Indonesia
    optimized = this.addIndonesianPauses(optimized);
    
    // Normalisasi akhir
    optimized = optimized.replace(/\s+/g, ' ');
    optimized = optimized.replace(/\s+([.,!?;:])/g, '$1');
    optimized = optimized.replace(/([.,!?;:])(\S)/g, '$1 $2');
    
    return optimized.trim();
  }

  /**
   * Normalisasi teks Indonesia
   */
  normalizeIndonesianText(text) {
    let normalized = text;
    
    // Normalisasi ejaan tidak baku -> baku
    const spellingNormalizations = {
      'gak': 'tidak',
      'nggak': 'tidak',
      'ga': 'tidak',
      'ngga': 'tidak',
      'kagak': 'tidak',
      'enggak': 'tidak',
      'loe': 'kamu',
      'lu': 'kamu',
      'elu': 'kamu',
      'gua': 'saya',
      'gue': 'saya',
      'gw': 'saya',
      'ane': 'saya',
      'ente': 'anda',
      'antum': 'anda',
      'dah': 'sudah',
      'udah': 'sudah',
      'udh': 'sudah',
      'dlu': 'dulu',
      'dl': 'dulu',
      'klo': 'kalau',
      'kl': 'kalau',
      'kalo': 'kalau',
      'klo': 'kalau',
      'klo': 'kalau',
      'yg': 'yang',
      'yg': 'yang',
      'dg': 'dengan',
      'dgn': 'dengan',
      'dng': 'dengan',
      'utk': 'untuk',
      'utk': 'untuk',
      'utk': 'untuk',
      'pd': 'pada',
      'dpt': 'dapat',
      'bs': 'bisa',
      'bisa': 'dapat',
      'bisa': 'dapat',
      'bgs': 'bagus',
      'bagus': 'baik',
      'bgmn': 'bagaimana',
      'gmn': 'bagaimana',
      'gimana': 'bagaimana',
      'krn': 'karena',
      'karna': 'karena',
      'karena': 'sebab',
      'jd': 'jadi',
      'jdi': 'jadi',
      'tdk': 'tidak',
      'gk': 'tidak',
      'tsb': 'tersebut',
      'trsbt': 'tersebut',
      'dlm': 'dalam',
      'dalam': 'di dalam',
      'spt': 'seperti',
      'spti': 'seperti',
      'kyk': 'seperti',
      'kaya': 'seperti',
      'kayak': 'seperti',
      'ato': 'atau',
      'atau': 'ataukah',
      'sdh': 'sudah',
      'sblm': 'sebelum',
      'sblum': 'sebelum',
      'stlh': 'setelah',
      'stlah': 'setelah',
      'setelah': 'sesudah',
      'sm': 'sama',
      'smua': 'semua',
      'smw': 'semua',
      'skrg': 'sekarang',
      'skrng': 'sekarang',
      'skarang': 'sekarang',
      'tgl': 'tanggal',
      'tggl': 'tanggal',
      'bln': 'bulan',
      'thn': 'tahun',
      'th': 'tahun',
      't4': 'tempat',
      'tpt': 'tempat',
      'byk': 'banyak',
      'byk': 'banyak',
      'bnyk': 'banyak',
      'sdikit': 'sedikit',
      'sdkt': 'sedikit',
      'dkt': 'dekat',
      'jln': 'jalan',
      'jl': 'jalan',
      'org': 'orang',
      'orng': 'orang',
      'mkn': 'makan',
      'mkan': 'makan',
      'minum': 'minum',
      'mnum': 'minum',
      'tdr': 'tidur',
      'tdur': 'tidur',
      'mlm': 'malam',
      'mlam': 'malam',
      'pgi': 'pagi',
      'sore': 'petang',
      'malam': 'malam hari',
      'pke': 'pakai',
      'pake': 'pakai',
      'pki': 'pakai',
      'pk': 'pakai',
      'lbh': 'lebih',
      'lbih': 'lebih',
      'kurang': 'kurang',
      'krg': 'kurang',
      'sgt': 'sangat',
      'sngt': 'sangat',
      'amat': 'sangat',
      'sekali': 'sekali',
      'skli': 'sekali',
      'skl': 'sekali',
      'mdh': 'mudah',
      'mdh2an': 'mudah-mudahan',
      'mdh2in': 'mudah-mudahan',
      'smoga': 'semoga',
      'smga': 'semoga',
      'insyaallah': 'insya Allah',
      'insya allah': 'insya Allah',
      'inshaallah': 'insya Allah',
      'assalamualaikum': 'assalamu alaikum',
      'wr wb': 'wa rahmatullahi wa barakatuh',
      'wassalamualaikum': 'wassalamu alaikum',
      'wslm': 'wassalam',
      'syukur': 'alhamdulillah',
      'alhamdulillah': 'segala puji bagi Allah',
      'subhanallah': 'mahasuci Allah',
      'masyaallah': 'atas kehendak Allah',
      'astagfirullah': 'aku mohon ampun kepada Allah',
      'laailahaillallah': 'tiada tuhan selain Allah',
    };
    
    // Urutkan dari yang terpanjang untuk menghindari penggantian sebagian
    const sortedKeys = Object.keys(spellingNormalizations).sort((a, b) => b.length - a.length);
    
    sortedKeys.forEach(key => {
      const regex = new RegExp(`\\b${key}\\b`, 'gi');
      normalized = normalized.replace(regex, spellingNormalizations[key]);
    });
    
    // Kapitalisasi yang benar untuk nama bulan, hari, dan istilah khusus
    const capitalizeTerms = [
      'januari', 'februari', 'maret', 'april', 'mei', 'juni',
      'juli', 'agustus', 'september', 'oktober', 'november', 'desember',
      'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu',
      'allah', 'muhammad', 'nabi', 'rasul', 'islam', 'muslim', 'quran',
      'indonesia', 'jakarta', 'surabaya', 'bandung', 'medan', 'semarang'
    ];
    
    capitalizeTerms.forEach(term => {
      const regex = new RegExp(`\\b${term}\\b`, 'gi');
      normalized = normalized.replace(regex, (match) => 
        match.charAt(0).toUpperCase() + match.slice(1)
      );
    });
    
    return normalized;
  }

  /**
   * Konversi angka ke kata untuk pelafalan lebih natural
   */
  convertNumbersToWords(text) {
    let converted = text;
    
    // Angka 0-12 diucapkan sebagai kata
    const numberWords = {
      '0': 'nol', '1': 'satu', '2': 'dua', '3': 'tiga', '4': 'empat',
      '5': 'lima', '6': 'enam', '7': 'tujuh', '8': 'delapan', '9': 'sembilan',
      '10': 'sepuluh', '11': 'sebelas', '12': 'dua belas',
      '13': 'tiga belas', '14': 'empat belas', '15': 'lima belas',
      '16': 'enam belas', '17': 'tujuh belas', '18': 'delapan belas',
      '19': 'sembilan belas', '20': 'dua puluh'
    };
    
    // Untuk angka di bawah 100, konversi jika berdiri sendiri
    Object.keys(numberWords).forEach(num => {
      const regex = new RegExp(`\\b${num}\\b`, 'g');
      converted = converted.replace(regex, numberWords[num]);
    });
    
    // Format ribuan dengan titik (Indonesia style)
    converted = converted.replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1.');
    
    // Tanggal format: 12-03-2024 -> 12 Maret 2024
    const dateRegex = /(\d{1,2})[-/](\d{1,2})[-/](\d{4})/g;
    converted = converted.replace(dateRegex, (match, day, month, year) => {
      const months = [
        'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
        'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
      ];
      return `${day} ${months[parseInt(month) - 1] || month} ${year}`;
    });
    
    return converted;
  }

  /**
   * Normalisasi singkatan Indonesia
   */
  normalizeIndonesianAbbreviations(text) {
    let normalized = text;
    
    const indonesianAbbreviations = {
      'dr.': 'dokter',
      'Dr.': 'Dokter',
      'dr': 'dokter',
      'Dr': 'Dokter',
      'drs.': 'doktorandus',
      'Drs.': 'Doktorandus',
      'prof.': 'profesor',
      'Prof.': 'Profesor',
      'hr': 'hari',
      'hr.': 'hari',
      'Hr': 'Hari',
      'bln': 'bulan',
      'bln.': 'bulan',
      'Bln': 'Bulan',
      'thn': 'tahun',
      'thn.': 'tahun',
      'Thn': 'Tahun',
      'jln': 'jalan',
      'jln.': 'jalan',
      'Jl.': 'Jalan',
      'jl': 'jalan',
      'jl.': 'jalan',
      'no.': 'nomor',
      'No.': 'Nomor',
      'no': 'nomor',
      'No': 'Nomor',
      'rt': 'R T',
      'RT': 'R T',
      'rw': 'R W',
      'RW': 'R W',
      'dll': 'dan lain-lain',
      'dll.': 'dan lain-lain',
      'dkk': 'dan kawan-kawan',
      'dkk.': 'dan kawan-kawan',
      'd/a': 'dengan alamat',
      'D/A': 'Dengan Alamat',
      'dgn': 'dengan',
      'dgn.': 'dengan',
      'dng': 'dengan',
      'dng.': 'dengan',
      'd': 'dengan',
      'D': 'Dengan',
      'yg': 'yang',
      'Yg': 'Yang',
      'yg.': 'yang',
      'Yg.': 'Yang',
      'utk': 'untuk',
      'Utk': 'Untuk',
      'utk.': 'untuk',
      'Utk.': 'Untuk',
      'pd': 'pada',
      'Pd': 'Pada',
      'pd.': 'pada',
      'Pd.': 'Pada',
      'dpt': 'dapat',
      'Dpt': 'Dapat',
      'dpt.': 'dapat',
      'Dpt.': 'Dapat',
      'tdk': 'tidak',
      'Tdk': 'Tidak',
      'tdk.': 'tidak',
      'Tdk.': 'Tidak',
      'bs': 'bisa',
      'Bs': 'Bisa',
      'bs.': 'bisa',
      'Bs.': 'Bisa',
      'bisa': 'dapat',
      'Bisa': 'Dapat',
      'krn': 'karena',
      'Krn': 'Karena',
      'krn.': 'karena',
      'Krn.': 'Karena',
      'jd': 'jadi',
      'Jd': 'Jadi',
      'jd.': 'jadi',
      'Jd.': 'Jadi',
      'tsb': 'tersebut',
      'Tsb': 'Tersebut',
      'tsb.': 'tersebut',
      'Tsb.': 'Tersebut',
      'dlm': 'dalam',
      'Dlm': 'Dalam',
      'dlm.': 'dalam',
      'Dlm.': 'Dalam',
      'spt': 'seperti',
      'Spt': 'Seperti',
      'spt.': 'seperti',
      'Spt.': 'Seperti',
      'kyk': 'seperti',
      'Kyk': 'Seperti',
      'kyk.': 'seperti',
      'Kyk.': 'Seperti',
      'ato': 'atau',
      'Ato': 'Atau',
      'ato.': 'atau',
      'Ato.': 'Atau',
      'sdh': 'sudah',
      'Sdh': 'Sudah',
      'sdh.': 'sudah',
      'Sdh.': 'Sudah',
      'sblm': 'sebelum',
      'Sblm': 'Sebelum',
      'sblm.': 'sebelum',
      'Sblm.': 'Sebelum',
      'stlh': 'setelah',
      'Stlh': 'Setelah',
      'stlh.': 'setelah',
      'Stlh.': 'Setelah',
      'sm': 'sama',
      'Sm': 'Sama',
      'sm.': 'sama',
      'Sm.': 'Sama',
      'skrg': 'sekarang',
      'Skrg': 'Sekarang',
      'skrg.': 'sekarang',
      'Skrg.': 'Sekarang',
      'byk': 'banyak',
      'Byk': 'Banyak',
      'byk.': 'banyak',
      'Byk.': 'Banyak',
      'sdikit': 'sedikit',
      'Sdikit': 'Sedikit',
      'sdikit.': 'sedikit',
      'Sdikit.': 'Sedikit',
      'dkt': 'dekat',
      'Dkt': 'Dekat',
      'dkt.': 'dekat',
      'Dkt.': 'Dekat',
      'org': 'orang',
      'Org': 'Orang',
      'org.': 'orang',
      'Org.': 'Orang',
      'mkn': 'makan',
      'Mkn': 'Makan',
      'mkn.': 'makan',
      'Mkn.': 'Makan',
      'mnum': 'minum',
      'Mnum': 'Minum',
      'mnum.': 'minum',
      'Mnum.': 'Minum',
      'tdr': 'tidur',
      'Tdr': 'Tidur',
      'tdr.': 'tidur',
      'Tdr.': 'Tidur',
      'mlm': 'malam',
      'Mlm': 'Malam',
      'mlm.': 'malam',
      'Mlm.': 'Malam',
      'pgi': 'pagi',
      'Pgi': 'Pagi',
      'pgi.': 'pagi',
      'Pgi.': 'Pagi',
      'pke': 'pakai',
      'Pke': 'Pakai',
      'pke.': 'pakai',
      'Pke.': 'Pakai',
      'lbh': 'lebih',
      'Lbh': 'Lebih',
      'lbh.': 'lebih',
      'Lbh.': 'Lebih',
      'krg': 'kurang',
      'Krg': 'Kurang',
      'krg.': 'kurang',
      'Krg.': 'Kurang',
      'sgt': 'sangat',
      'Sgt': 'Sangat',
      'sgt.': 'sangat',
      'Sgt.': 'Sangat',
      'skli': 'sekali',
      'Skli': 'Sekali',
      'skli.': 'sekali',
      'Skli.': 'Sekali',
      'mdh': 'mudah',
      'Mdh': 'Mudah',
      'mdh.': 'mudah',
      'Mdh.': 'Mudah',
      'smga': 'semoga',
      'Smga': 'Semoga',
      'smga.': 'semoga',
      'Smga.': 'Semoga',
    };
    
    Object.keys(indonesianAbbreviations).forEach(abbr => {
      const regex = new RegExp(`\\b${abbr}\\b`, 'g');
      normalized = normalized.replace(regex, indonesianAbbreviations[abbr]);
    });
    
    return normalized;
  }

  /**
   * Penyesuaian untuk pelafalan natural Indonesia
   */
  adjustForNaturalPronunciation(text, language) {
    let adjusted = text;
    
    if (language.startsWith('id')) {
      // Penambahan "nya" yang sering diucapkan
      adjusted = adjusted.replace(/\b(saya|aku|kamu|dia|mereka|kita)\b/g, '$1');
      
      // Penyesuaian untuk partikel "lah" dan "kah"
      adjusted = adjusted.replace(/\b(apa|siapa|dimana|kapan|bagaimana|mengapa)\b/g, '$1');
      
      // Penggantian kata serapan asing
      const loanWords = {
        'computer': 'komputer',
        'laptop': 'laptop',
        'smartphone': 'ponsel pintar',
        'phone': 'telepon',
        'email': 'surel',
        'internet': 'internet',
        'website': 'situs web',
        'online': 'daring',
        'offline': 'luring',
        'download': 'unduh',
        'upload': 'unggah',
        'link': 'tautan',
        'click': 'klik',
        'password': 'kata sandi',
        'username': 'nama pengguna',
        'software': 'perangkat lunak',
        'hardware': 'perangkat keras',
        'data': 'data',
        'file': 'berkas',
        'folder': 'map',
        'delete': 'hapus',
        'save': 'simpan',
        'cancel': 'batal',
        'confirm': 'konfirmasi',
        'message': 'pesan',
        'notification': 'notifikasi',
        'setting': 'pengaturan',
        'profile': 'profil',
        'account': 'akun',
        'payment': 'pembayaran',
        'transaction': 'transaksi',
        'balance': 'saldo',
        'transfer': 'transfer',
        'withdraw': 'tarik',
        'deposit': 'setor',
        'bank': 'bank',
        'card': 'kartu',
        'cash': 'tunai',
        'price': 'harga',
        'discount': 'diskon',
        'promo': 'promosi',
        'free': 'gratis',
        'paid': 'berbayar',
        'service': 'layanan',
        'support': 'dukungan',
        'help': 'bantuan',
        'contact': 'kontak',
        'address': 'alamat',
        'location': 'lokasi',
        'map': 'peta',
        'navigation': 'navigasi',
        'direction': 'arah',
        'distance': 'jarak',
        'time': 'waktu',
        'date': 'tanggal',
        'schedule': 'jadwal',
        'appointment': 'janji temu',
        'meeting': 'rapat',
        'conference': 'konferensi',
        'presentation': 'presentasi',
        'document': 'dokumen',
        'report': 'laporan',
        'analysis': 'analisis',
        'research': 'penelitian',
        'development': 'pengembangan',
        'improvement': 'perbaikan',
        'innovation': 'inovasi',
        'technology': 'teknologi',
        'science': 'ilmu pengetahuan',
        'education': 'pendidikan',
        'learning': 'pembelajaran',
        'teaching': 'pengajaran',
        'student': 'siswa',
        'teacher': 'guru',
        'school': 'sekolah',
        'university': 'universitas',
        'college': 'perguruan tinggi',
        'course': 'kursus',
        'training': 'pelatihan',
        'workshop': 'lokakarya',
        'seminar': 'seminar',
        'webinar': 'webinar',
        'certificate': 'sertifikat',
        'diploma': 'ijazah',
        'degree': 'gelar',
        'profession': 'profesi',
        'career': 'karier',
        'job': 'pekerjaan',
        'work': 'kerja',
        'employee': 'karyawan',
        'employer': 'pemberi kerja',
        'company': 'perusahaan',
        'business': 'bisnis',
        'industry': 'industri',
        'market': 'pasar',
        'marketing': 'pemasaran',
        'sales': 'penjualan',
        'customer': 'pelanggan',
        'client': 'klien',
        'consumer': 'konsumen',
        'product': 'produk',
        'production': 'produksi',
        'quality': 'kualitas',
        'quantity': 'kuantitas',
        'standard': 'standar',
        'certification': 'sertifikasi',
        'inspection': 'inspeksi',
        'audit': 'audit',
        'compliance': 'kepatuhan',
        'regulation': 'regulasi',
        'law': 'hukum',
        'legal': 'hukum',
        'court': 'pengadilan',
        'judge': 'hakim',
        'lawyer': 'pengacara',
        'police': 'polisi',
        'security': 'keamanan',
        'safety': 'keselamatan',
        'health': 'kesehatan',
        'medical': 'medis',
        'hospital': 'rumah sakit',
        'doctor': 'dokter',
        'nurse': 'perawat',
        'patient': 'pasien',
        'medicine': 'obat',
        'treatment': 'perawatan',
        'therapy': 'terapi',
        'recovery': 'pemulihan',
        'prevention': 'pencegahan',
        'vaccine': 'vaksin',
        'virus': 'virus',
        'bacteria': 'bakteri',
        'infection': 'infeksi',
        'disease': 'penyakit',
        'symptom': 'gejala',
        'diagnosis': 'diagnosis',
        'prescription': 'resep',
        'surgery': 'operasi',
        'emergency': 'darurat',
        'ambulance': 'ambulan',
        'insurance': 'asuransi',
        'claim': 'klaim',
        'premium': 'premi',
        'coverage': 'pertanggungan',
        'benefit': 'manfaat',
        'pension': 'pensiun',
        'retirement': 'pensiun',
        'investment': 'investasi',
        'savings': 'tabungan',
        'loan': 'pinjaman',
        'credit': 'kredit',
        'debit': 'debit',
        'interest': 'bunga',
        'profit': 'laba',
        'loss': 'rugi',
        'asset': 'aset',
        'liability': 'kewajiban',
        'equity': 'ekuitas',
        'revenue': 'pendapatan',
        'expense': 'pengeluaran',
        'budget': 'anggaran',
        'finance': 'keuangan',
        'accounting': 'akuntansi',
        'auditing': 'pengauditan',
        'tax': 'pajak',
        'duty': 'bea',
        'custom': 'bea cukai',
        'import': 'impor',
        'export': 'ekspor',
        'shipping': 'pengiriman',
        'delivery': 'pengantaran',
        'logistics': 'logistik',
        'supply': 'pasokan',
        'demand': 'permintaan',
        'inventory': 'persediaan',
        'warehouse': 'gudang',
        'storage': 'penyimpanan',
        'transportation': 'transportasi',
        'vehicle': 'kendaraan',
        'car': 'mobil',
        'motorcycle': 'sepeda motor',
        'bicycle': 'sepeda',
        'bus': 'bis',
        'train': 'kereta',
        'plane': 'pesawat',
        'ship': 'kapal',
        'boat': 'perahu',
        'airport': 'bandara',
        'station': 'stasiun',
        'port': 'pelabuhan',
        'terminal': 'terminal',
        'ticket': 'tiket',
        'reservation': 'reservasi',
        'booking': 'pemesanan',
        'checkin': 'check-in',
        'checkout': 'check-out',
        'hotel': 'hotel',
        'restaurant': 'restoran',
        'cafe': 'kafe',
        'menu': 'menu',
        'food': 'makanan',
        'drink': 'minuman',
        'water': 'air',
        'coffee': 'kopi',
        'tea': 'teh',
        'juice': 'jus',
        'milk': 'susu',
        'bread': 'roti',
        'rice': 'nasi',
        'noodle': 'mi',
        'soup': 'sup',
        'salad': 'salad',
        'fruit': 'buah',
        'vegetable': 'sayuran',
        'meat': 'daging',
        'chicken': 'ayam',
        'beef': 'daging sapi',
        'fish': 'ikan',
        'egg': 'telur',
        'cheese': 'keju',
        'butter': 'mentega',
        'oil': 'minyak',
        'salt': 'garam',
        'sugar': 'gula',
        'spice': 'rempah',
        'recipe': 'resep',
        'cooking': 'memasak',
        'baking': 'memanggang',
        'grilling': 'memanggang',
        'frying': 'menggoreng',
        'boiling': 'merebus',
        'steaming': 'mengukus',
        'kitchen': 'dapur',
        'utensil': 'peralatan',
        'plate': 'piring',
        'bowl': 'mangkuk',
        'cup': 'cangkir',
        'glass': 'gelas',
        'spoon': 'sendok',
        'fork': 'garpu',
        'knife': 'pisau',
        'cleaning': 'pembersihan',
        'washing': 'mencuci',
        'drying': 'pengeringan',
        'ironing': 'menyeterika',
        'house': 'rumah',
        'home': 'rumah',
        'apartment': 'apartemen',
        'room': 'kamar',
        'bedroom': 'kamar tidur',
        'bathroom': 'kamar mandi',
        'kitchen': 'dapur',
        'living': 'ruang tamu',
        'dining': 'ruang makan',
        'garden': 'taman',
        'yard': 'halaman',
        'pool': 'kolam',
        'garage': 'garasi',
        'parking': 'parkir',
        'furniture': 'perabotan',
        'table': 'meja',
        'chair': 'kursi',
        'bed': 'tempat tidur',
        'sofa': 'sofa',
        'cabinet': 'lemari',
        'shelf': 'rak',
        'closet': 'lemari pakaian',
        'mirror': 'cermin',
        'lamp': 'lampu',
        'light': 'cahaya',
        'electricity': 'listrik',
        'power': 'daya',
        'energy': 'energi',
        'battery': 'baterai',
        'charger': 'pengisi daya',
        'cable': 'kabel',
        'wire': 'kawat',
        'plug': 'steker',
        'socket': 'stopkontak',
        'switch': 'saklar',
        'button': 'tombol',
        'control': 'kendali',
        'remote': 'remote',
        'device': 'perangkat',
        'gadget': 'gawai',
        'tool': 'alat',
        'equipment': 'peralatan',
        'machine': 'mesin',
        'engine': 'mesin',
        'motor': 'motor',
        'generator': 'generator',
        'pump': 'pompa',
        'fan': 'kipas',
        'air': 'udara',
        'conditioner': 'pengondisi',
        'heater': 'pemanas',
        'cooler': 'pendingin',
        'refrigerator': 'lemari es',
        'freezer': 'pembeku',
        'oven': 'oven',
        'microwave': 'microwave',
        'toaster': 'pemanggang',
        'blender': 'blender',
        'mixer': 'mixer',
        'processor': 'prosesor',
        'computer': 'komputer',
        'laptop': 'laptop',
        'tablet': 'tablet',
        'smartphone': 'ponsel pintar',
        'phone': 'telepon',
        'camera': 'kamera',
        'video': 'video',
        'audio': 'audio',
        'sound': 'suara',
        'music': 'musik',
        'song': 'lagu',
        'singer': 'penyanyi',
        'band': 'band',
        'instrument': 'alat musik',
        'guitar': 'gitar',
        'piano': 'piano',
        'violin': 'biola',
        'drum': 'drum',
        'concert': 'konser',
        'performance': 'pertunjukan',
        'show': 'pertunjukan',
        'movie': 'film',
        'cinema': 'bioskop',
        'theater': 'teater',
        'stage': 'panggung',
        'actor': 'aktor',
        'actress': 'aktris',
        'director': 'sutradara',
        'producer': 'produser',
        'writer': 'penulis',
        'script': 'skrip',
        'story': 'cerita',
        'plot': 'alur',
        'character': 'karakter',
        'role': 'peran',
        'scene': 'adegan',
        'dialogue': 'dialog',
        'monologue': 'monolog',
        'narration': 'narasi',
        'voice': 'suara',
        'dubbing': 'sulih suara',
        'subtitles': 'teks terjemahan',
        'translation': 'terjemahan',
        'interpretation': 'interpretasi',
        'language': 'bahasa',
        'word': 'kata',
        'sentence': 'kalimat',
        'paragraph': 'paragraf',
        'text': 'teks',
        'document': 'dokumen',
        'book': 'buku',
        'novel': 'novel',
        'poem': 'puisi',
        'poetry': 'puisi',
        'literature': 'sastra',
        'author': 'penulis',
        'writer': 'penulis',
        'publisher': 'penerbit',
        'edition': 'edisi',
        'volume': 'volume',
        'chapter': 'bab',
        'page': 'halaman',
        'cover': 'sampul',
        'title': 'judul',
        'heading': 'judul',
        'subtitle': 'subjudul',
        'caption': 'keterangan',
        'footnote': 'catatan kaki',
        'reference': 'referensi',
        'citation': 'kutipan',
        'quote': 'kutipan',
        'source': 'sumber',
        'resource': 'sumber daya',
        'material': 'materi',
        'content': 'konten',
        'information': 'informasi',
        'knowledge': 'pengetahuan',
        'wisdom': 'kebijaksanaan',
        'intelligence': 'kecerdasan',
        'smart': 'cerdas',
        'clever': 'pintar',
        'brilliant': 'brilian',
        'genius': 'jenius',
        'talent': 'bakat',
        'skill': 'keterampilan',
        'ability': 'kemampuan',
        'capacity': 'kapasitas',
        'potential': 'potensi',
        'opportunity': 'kesempatan',
        'chance': 'peluang',
        'possibility': 'kemungkinan',
        'probability': 'probabilitas',
        'statistics': 'statistik',
        'data': 'data',
        'number': 'angka',
        'figure': 'angka',
        'graph': 'grafik',
        'chart': 'bagan',
        'table': 'tabel',
        'diagram': 'diagram',
        'image': 'gambar',
        'picture': 'gambar',
        'photo': 'foto',
        'photograph': 'fotografi',
        'illustration': 'ilustrasi',
        'drawing': 'gambar',
        'painting': 'lukisan',
        'art': 'seni',
        'artist': 'seniman',
        'design': 'desain',
        'designer': 'perancang',
        'style': 'gaya',
        'fashion': 'mode',
        'clothing': 'pakaian',
        'clothes': 'pakaian',
        'shirt': 'kemeja',
        'pants': 'celana',
        'jeans': 'jeans',
        'skirt': 'rok',
        'dress': 'gaun',
        'suit': 'setelan',
        'jacket': 'jaket',
        'coat': 'mantel',
        'sweater': 'sweter',
        't-shirt': 'kaos',
        'underwear': 'pakaian dalam',
        'socks': 'kaos kaki',
        'shoes': 'sepatu',
        'sneakers': 'sepatu kets',
        'boots': 'sepatu bot',
        'sandals': 'sandal',
        'hat': 'topi',
        'cap': 'topi',
        'glasses': 'kacamata',
        'sunglasses': 'kacamata hitam',
        'watch': 'jam tangan',
        'jewelry': 'perhiasan',
        'ring': 'cincin',
        'necklace': 'kalung',
        'bracelet': 'gelang',
        'earrings': 'anting',
        'accessory': 'aksesori',
        'bag': 'tas',
        'purse': 'dompet',
        'wallet': 'dompet',
        'backpack': 'ransel',
        'luggage': 'bagasi',
        'suitcase': 'koper',
        'cosmetics': 'kosmetik',
        'makeup': 'makeup',
        'perfume': 'parfum',
        'soap': 'sabun',
        'shampoo': 'sampo',
        'conditioner': 'kondisioner',
        'toothpaste': 'pasta gigi',
        'toothbrush': 'sikat gigi',
        'towel': 'handuk',
        'tissue': 'tisu',
        'napkin': 'serbet',
        'diaper': 'popok',
        'sanitary': 'sanitasi',
        'hygiene': 'kebersihan',
        'cleanliness': 'kebersihan',
        'pollution': 'polusi',
        'environment': 'lingkungan',
        'nature': 'alam',
        'forest': 'hutan',
        'jungle': 'hutan',
        'mountain': 'gunung',
        'hill': 'bukit',
        'valley': 'lembah',
        'river': 'sungai',
        'lake': 'danau',
        'sea': 'laut',
        'ocean': 'samudra',
        'beach': 'pantai',
        'island': 'pulau',
        'continent': 'benua',
        'country': 'negara',
        'nation': 'bangsa',
        'state': 'negara bagian',
        'city': 'kota',
        'town': 'kota kecil',
        'village': 'desa',
        'community': 'komunitas',
        'society': 'masyarakat',
        'population': 'populasi',
        'people': 'orang',
        'person': 'orang',
      };
      
      // Urutkan dari terpanjang
      const sortedLoanWords = Object.keys(loanWords).sort((a, b) => b.length - a.length);
      
      sortedLoanWords.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        adjusted = adjusted.replace(regex, loanWords[word]);
      });
    }
    
    return adjusted;
  }

  /**
   * Tambahkan jeda natural untuk intonasi Indonesia
   */
  addIndonesianPauses(text) {
    let withPauses = text;
    
    // Jeda setelah konjungsi
    const conjunctions = [
      'dan', 'atau', 'tetapi', 'namun', 'melainkan',
      'karena', 'sebab', 'jadi', 'maka',
      'jika', 'kalau', 'apabila', 'bila',
      'walaupun', 'meskipun', 'biarpun',
      'agar', 'supaya', 'untuk',
      'sehingga', 'sampai',
      'ketika', 'saat', 'sementara',
      'sebelum', 'sesudah', 'setelah',
      'dengan', 'tanpa',
      'tentang', 'mengenai',
      'sebagai', 'bagi',
      'menurut', 'berdasarkan'
    ];
    
    conjunctions.forEach(conj => {
      const regex = new RegExp(`\\b${conj}\\b\\s`, 'gi');
      withPauses = withPauses.replace(regex, `${conj}<pause> `);
    });
    
    // Jeda sebelum kata tanya
    const questionWords = ['apa', 'siapa', 'dimana', 'kemana', 'darimana', 
                          'kapan', 'berapa', 'bagaimana', 'mengapa', 'kenapa'];
    
    questionWords.forEach(q => {
      const regex = new RegExp(`\\s${q}\\b`, 'gi');
      withPauses = withPauses.replace(regex, ` <pause>${q}`);
    });
    
    // Jeda untuk penekanan
    withPauses = withPauses.replace(/(sangat|amat|terlalu|sekali)\s/g, '$1<pause> ');
    withPauses = withPauses.replace(/\s(pasti|tentu|jelas)\s/g, ' <pause>$1<pause> ');
    
    return withPauses;
  }

  /**
   * Truncate text dengan mempertahankan makna Indonesia
   */
  truncateText(text, maxLength = 200) {
    if (text.length <= maxLength) return text;
    
    let truncated = text.substring(0, maxLength);
    
    // Cari akhir kalimat yang natural untuk bahasa Indonesia
    const sentenceEnd = Math.max(
      truncated.lastIndexOf('. '),
      truncated.lastIndexOf('? '),
      truncated.lastIndexOf('! '),
      truncated.lastIndexOf(', '),
      truncated.lastIndexOf('; ')
    );
    
    if (sentenceEnd > maxLength * 0.6) {
      truncated = truncated.substring(0, sentenceEnd + 1);
    } else {
      // Cari akhir frase
      const phraseMarkers = [' kemudian ', ' lalu ', ' setelah itu ', ' selanjutnya ', 
                            ' pertama ', ' kedua ', ' ketiga ', ' selain ', ' di samping '];
      
      let bestPhraseEnd = -1;
      phraseMarkers.forEach(marker => {
        const pos = truncated.lastIndexOf(marker);
        if (pos > bestPhraseEnd) bestPhraseEnd = pos;
      });
      
      if (bestPhraseEnd > maxLength * 0.5) {
        truncated = truncated.substring(0, bestPhraseEnd);
      } else {
        // Potong di spasi terakhir
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > maxLength * 0.4) {
          truncated = truncated.substring(0, lastSpace);
        }
      }
    }
    
    // Tambahkan indikator truncate yang natural
    if (!truncated.endsWith('.') && !truncated.endsWith('?') && !truncated.endsWith('!')) {
      truncated += '...';
    } else {
      truncated += ' ..';
    }
    
    return truncated;
  }

  /**
   * Validasi input untuk bahasa Indonesia
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
    
    // Batasan lebih ketat untuk bahasa Indonesia
    const maxLength = language.startsWith('id') ? 3000 : 5000;
    if (text.length > maxLength) {
        errors.push(`Text terlalu panjang (${text.length} karakter, maksimal ${maxLength} untuk ${language})`);
    }
    
    if (!language || language.trim().length === 0) {
        errors.push('Language tidak boleh kosong');
    }
    
    // Validasi karakter khusus
    const invalidChars = text.match(/[<>{}]/g);
    if (invalidChars) {
        errors.push(`Text mengandung karakter tidak valid: ${invalidChars.join(', ')}`);
    }
    
    console.log(`Validation for ${language} text (${text.length} chars):`, errors.length > 0 ? errors : 'Valid');
    return errors;
}

  /**
   * Konversi text ke speech dengan optimasi Indonesia
   */
async convertTextToSpeech({ text, language = 'id-ID', speed = 0.85, pitch = 1.0 }) {
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
            throw new Error('Batas penggunaan tercapai. Silakan coba lagi nanti.');
        }

        // Optimasi teks khusus Indonesia
        const optimizedText = this.optimizeTextForSpeech(text, language);
        
        // Truncate dengan logika Indonesia
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
        
        // Token untuk bahasa yang mendukung
        if (['id-ID', 'en-US', 'en-GB', 'ms'].includes(langCode)) {
            params.append('tk', this.generateToken(truncatedText));
        }
        
        const ttsUrl = `${this.baseUrl}?${params.toString()}`;
        
        console.log(`[${new Date().toLocaleString('id-ID')}] TTS Request: ${langCode}, Panjang: ${truncatedText.length}, Kecepatan: ${speed}`);
        
        // Konfigurasi request
        const maxSizeMB = parseInt(process.env.MAX_AUDIO_SIZE_MB) || 2;
        const maxSizeBytes = maxSizeMB * 1024 * 1024;
        
        // Request ke Google TTS
        const response = await axios.get(ttsUrl, {
            responseType: 'arraybuffer',
            timeout: parseInt(process.env.REQUEST_TIMEOUT) || 40000,
            headers: {
                ...this.defaultHeaders,
                'Accept': 'audio/mpeg, audio/*',
                'Accept-Language': 'id-ID,id;q=0.9',
                'Accept-Encoding': 'identity',
            },
            maxContentLength: maxSizeBytes,
            maxBodyLength: maxSizeBytes,
            maxRedirects: 5,
            decompress: true,
            validateStatus: function (status) {
                return status >= 200 && status < 300;
            }
        });
        
        // Validasi response
        if (!response.data || response.data.length === 0) {
            throw new Error('Google TTS tidak mengembalikan data audio');
        }
        
        // Deteksi format audio
        const audioFormat = this.detectAudioFormat(response.data);
        
        // Konversi ke base64
        const audioBase64 = Buffer.from(response.data).toString('base64');
        const audioDataUrl = `data:${audioFormat};base64,${audioBase64}`;
        
        // Durasi estimasi
        const duration = this.estimateDuration(truncatedText, speed, language);
        
        // Metadata untuk bahasa Indonesia
        const metadata = {
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
            voiceGender: this.getVoiceGender(language),
            timestamp: new Date().toLocaleString('id-ID'),
            audioSize: response.data.length,
            optimizationLevel: this.getOptimizationLevel(optimizedText, text)
        };
        
        // Tambahkan rekomendasi untuk Indonesia
        if (language.startsWith('id')) {
            metadata.recommendations = this.getIndonesianRecommendations();
        }
        
        return metadata;
        
    } catch (error) {
        console.error(`[${new Date().toLocaleString('id-ID')}] Error TTS:`, error.message);
        
        let userMessage = 'Gagal mengonversi teks ke suara';
        
        if (error.response) {
            userMessage = `Google TTS menolak permintaan (Status: ${error.response.status}). Coba ganti bahasa atau kurangi teks.`;
        } else if (error.code === 'ECONNABORTED') {
            userMessage = 'Waktu tunggu habis: Google TTS tidak merespons. Coba lagi nanti.';
        } else if (error.message.includes('Batas penggunaan')) {
            userMessage = error.message;
        } else if (error.message.includes('maxContentLength')) {
            userMessage = 'Ukuran audio terlalu besar. Coba teks yang lebih pendek.';
        } else if (error.message.includes('ENOTFOUND')) {
            userMessage = 'Tidak dapat terhubung ke Google TTS. Periksa koneksi internet.';
        } else if (error.message.includes('karakter tidak valid')) {
            userMessage = 'Teks mengandung karakter yang tidak didukung.';
        }
        
        throw new Error(`${userMessage} (Detail: ${error.message})`);
    }
}

  /**
   * Generate token untuk request
   */
  generateToken(text) {
    const timestamp = Date.now();
    return Buffer.from(`${text}-${timestamp}`).toString('base64').substring(0, 20);
  }

  /**
   * Deteksi format audio
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
    const charsPerMinuteMap = {
      'id-ID': 140, 'id': 140, 'ms': 140, 'su': 130, 'jw': 130,
      'en-US': 150, 'en-GB': 150, 'en': 150,
      'th': 120, 'vi': 130
    };
    
    const langCode = this.mapLanguageCode(language);
    const baseCharsPerMinute = charsPerMinuteMap[langCode] || 140;
    const adjustedCharsPerMinute = baseCharsPerMinute * speed;
    
    // Estimasi untuk bahasa Indonesia lebih akurat
    let durationInSeconds = (text.length / adjustedCharsPerMinute) * 60;
    
    // Faktor koreksi untuk bahasa Indonesia
    if (language.startsWith('id')) {
      const vowelCount = (text.match(/[aeiou]/gi) || []).length;
      const consonantCount = (text.match(/[bcdfghjklmnpqrstvwxyz]/gi) || []).length;
      
      // Bahasa Indonesia lebih banyak vokal, durasi lebih panjang
      if (vowelCount > consonantCount * 0.8) {
        durationInSeconds *= 1.1;
      }
    }
    
    // Hitung jeda
    const naturalPauses = (text.match(/[.,!?;:]/g) || []).length;
    const pauseTime = naturalPauses * 0.4; // Jeda lebih panjang untuk Indonesia
    
    // Tag pause custom
    const customPauses = (text.match(/<pause>/g) || []).length;
    const customPauseTime = customPauses * 0.5;
    
    return Math.max(0.5, Math.round((durationInSeconds + pauseTime + customPauseTime) * 10) / 10);
  }

  /**
   * Dapatkan gender suara berdasarkan bahasa
   */
  getVoiceGender(language) {
    const femaleVoices = ['id-ID', 'id', 'ms', 'su', 'jw', 'en-US', 'en-GB', 'th', 'vi'];
    return femaleVoices.includes(language) ? 'female' : 'female';
  }

  /**
   * Level optimasi
   */
  getOptimizationLevel(optimized, original) {
    const changes = optimized !== original ? 1 : 0;
    const lengthDiff = Math.abs(optimized.length - original.length);
    
    if (changes === 0 && lengthDiff === 0) return 'none';
    if (lengthDiff > original.length * 0.3) return 'high';
    if (lengthDiff > original.length * 0.1) return 'medium';
    return 'low';
  }

  /**
   * Rekomendasi untuk bahasa Indonesia
   */
  getIndonesianRecommendations() {
    return {
      tips: [
        'Gunakan kalimat pendek dan jelas',
        'Hindari singkatan tidak resmi',
        'Gunakan tanda baca dengan benar',
        'Batas optimal: 15-20 kata per kalimat',
        'Kecepatan 0.8-0.9 paling natural untuk bahasa Indonesia'
      ],
      commonMistakes: [
        'Menggunakan "yg" bukan "yang"',
        'Menggunakan "gak" bukan "tidak"',
        'Menggunakan "loe" bukan "kamu"',
        'Tidak menggunakan kapital untuk nama bulan/hari'
      ],
      bestPractices: [
        'Gunakan ejaan yang disempurnakan (EYD)',
        'Tulis angka 0-12 sebagai kata',
        'Gunakan koma untuk jeda alami',
        'Kapitalkan nama bulan dan hari'
      ]
    };
  }

  /**
   * Daftar bahasa yang didukung dengan fokus Indonesia
   */
  getSupportedLanguages() {
    return [
      { 
        code: 'id-ID', 
        name: 'Bahasa Indonesia Standar', 
        nativeName: 'Bahasa Indonesia', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'Jakarta',
        recommendedSpeed: 0.85,
        naturalness: 9
      },
      { 
        code: 'id-JAKARTA', 
        name: 'Bahasa Indonesia (Dialek Jakarta)', 
        nativeName: 'Bahasa Indonesia Jakarta', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'Jakarta',
        recommendedSpeed: 0.9,
        naturalness: 10
      },
      { 
        code: 'id-SUNDA', 
        name: 'Bahasa Indonesia (Campur Sunda)', 
        nativeName: 'Basa Sunda', 
        voiceGender: 'female', 
        clarity: 'medium',
        dialect: 'Sunda',
        recommendedSpeed: 0.8,
        naturalness: 8
      },
      { 
        code: 'id-JAWA', 
        name: 'Bahasa Indonesia (Campur Jawa)', 
        nativeName: 'Basa Jawa', 
        voiceGender: 'female', 
        clarity: 'medium',
        dialect: 'Jawa',
        recommendedSpeed: 0.8,
        naturalness: 8
      },
      { 
        code: 'su-ID', 
        name: 'Bahasa Sunda', 
        nativeName: 'Basa Sunda', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'Sunda',
        recommendedSpeed: 0.85,
        naturalness: 9
      },
      { 
        code: 'jw-ID', 
        name: 'Bahasa Jawa', 
        nativeName: 'Basa Jawa', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'Jawa',
        recommendedSpeed: 0.85,
        naturalness: 9
      },
      { 
        code: 'ms-ID', 
        name: 'Bahasa Melayu Indonesia', 
        nativeName: 'Bahasa Melayu', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'Melayu',
        recommendedSpeed: 0.9,
        naturalness: 9
      },
      { 
        code: 'en-US', 
        name: 'English (US)', 
        nativeName: 'English', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'American',
        recommendedSpeed: 1.0,
        naturalness: 10
      },
      { 
        code: 'en-GB', 
        name: 'English (UK)', 
        nativeName: 'English', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'British',
        recommendedSpeed: 1.0,
        naturalness: 10
      },
      { 
        code: 'th-TH', 
        name: 'Thai', 
        nativeName: 'ภาษาไทย', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'Bangkok',
        recommendedSpeed: 0.9,
        naturalness: 9
      },
      { 
        code: 'vi-VN', 
        name: 'Vietnamese', 
        nativeName: 'Tiếng Việt', 
        voiceGender: 'female', 
        clarity: 'high',
        dialect: 'Hanoi',
        recommendedSpeed: 0.9,
        naturalness: 9
      },
    ];
  }

  /**
   * Test koneksi dengan pesan Indonesia
   */
  async testConnection() {
    try {
      const testText = 'Halo, selamat pagi. Ini adalah uji coba layanan teks ke suara.';
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
        message: 'Layanan Google TTS dapat diakses - Siap digunakan',
        timestamp: new Date().toLocaleString('id-ID'),
        language: 'id-ID',
        testText: testText
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Layanan Google TTS tidak dapat diakses',
        timestamp: new Date().toLocaleString('id-ID'),
        suggestion: 'Periksa koneksi internet atau firewall'
      };
    }
  }

  /**
   * Optimasi khusus untuk pelafalan angka dalam konteks Indonesia
   */
  optimizeNumbersForIndonesian(text) {
    let optimized = text;
    
    // Format uang: Rp 100000 -> Rp 100.000
    optimized = optimized.replace(/Rp\s*(\d+)/g, (match, amount) => {
      return `Rp ${parseInt(amount).toLocaleString('id-ID')}`;
    });
    
    // Format persen: 50% -> 50 persen
    optimized = optimized.replace(/(\d+)%/g, '$1 persen');
    
    // Format waktu: 14:30 -> pukul dua siang tiga puluh menit
    optimized = optimized.replace(/(\d{1,2}):(\d{2})/g, (match, hour, minute) => {
      const h = parseInt(hour);
      const m = parseInt(minute);
      let timeStr = `pukul ${h}`;
      if (m > 0) timeStr += ` lewat ${m} menit`;
      return timeStr;
    });
    
    return optimized;
  }
}

module.exports = new GoogleTTSService();
