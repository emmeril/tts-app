require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const googleTTSService = require('./services/googleTTSService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3000'],
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from frontend directory
app.use(express.static(path.join(__dirname, '../frontend')));

// API Routes
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Google TTS API',
    version: '1.0.0'
  });
});

app.get('/api/languages', (req, res) => {
  try {
    const languages = googleTTSService.getSupportedLanguages();
    res.json({
      success: true,
      languages: languages
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Gagal mengambil daftar bahasa'
    });
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const { text, language = 'id-ID', speed = 1.0 } = req.body;
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Text diperlukan untuk konversi TTS'
      });
    }

    // Validasi kecepatan
    const validSpeed = Math.max(0.5, Math.min(parseFloat(speed) || 1.0, 2.0));
    
    console.log(`TTS Request: ${language}, Speed: ${validSpeed}, Text Length: ${text.length}`);
    
    // Konversi text ke speech
    const result = await googleTTSService.convertTextToSpeech({
      text: text,
      language: language,
      speed: validSpeed
    });
    
    res.json(result);
    
  } catch (error) {
    console.error('Server Error:', error.message);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Terjadi kesalahan pada server',
      suggestion: 'Coba kurangi panjang teks atau ganti bahasa'
    });
  }
});

app.get('/api/test', async (req, res) => {
  try {
    const testResult = await googleTTSService.testConnection();
    res.json(testResult);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Terjadi kesalahan internal server',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint tidak ditemukan'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server Google TTS berjalan di http://localhost:${PORT}`);
  console.log(`📚 API Documentation:`);
  console.log(`   GET  /api/health      - Cek status server`);
  console.log(`   GET  /api/languages   - Daftar bahasa yang didukung`);
  console.log(`   POST /api/tts         - Konversi teks ke suara`);
  console.log(`   GET  /api/test        - Test koneksi ke Google TTS`);
  console.log(`\n🌐 Frontend tersedia di http://localhost:${PORT}`);
});