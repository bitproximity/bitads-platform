// routes/ads/uploads.js
// Sube el archivo del creativo directo a Supabase Storage (bucket
// "creatives") y devuelve la URL pública — reemplaza tener que alojar
// el archivo en otro lado y pegar la URL a mano.

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const advertiserAuth = require('../../middleware/advertiserAuth');

const MAX_FILE_SIZE_MB = 50;
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_MIME_PREFIXES.some(prefix => file.mimetype.startsWith(prefix));
    if (!ok) return cb(new Error('Tipo de archivo no permitido. Solo imagen, video o audio.'));
    cb(null, true);
  }
});

router.use(advertiserAuth);

// POST /api/ads/uploads/creative — campo de archivo: "file"
router.post('/creative', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `El archivo supera el límite de ${MAX_FILE_SIZE_MB}MB`
        : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    try {
      const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      const path = `${req.advertiserId}/${Date.now()}-${safeName}`;

      const { error: uploadErr } = await supabaseAdmin.storage
        .from('creatives')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

      if (uploadErr) throw uploadErr;

      const { data: publicUrlData } = supabaseAdmin.storage.from('creatives').getPublicUrl(path);

      res.status(201).json({
        file_url: publicUrlData.publicUrl,
        mimetype: req.file.mimetype,
        size_bytes: req.file.size
      });
    } catch (e) {
      console.error('[ads/uploads] POST /creative', e);
      res.status(500).json({ error: 'No se pudo subir el archivo' });
    }
  });
});

module.exports = router;
