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
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
// Un creativo por request. El campo del multipart es "file".
const MAX_FILES = 1;
// image/*, video/* y audio/* — lo que el player puede mostrar.
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];

function isAllowedMime(mimetype) {
  if (typeof mimetype !== 'string') return false;
  // Ignorar parámetros ("; charset=...") y rechazar tipos mal formados.
  const type = mimetype.split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) return false;
  return ALLOWED_MIME_PREFIXES.some(prefix => type.startsWith(prefix));
}

// multer 2.x: los límites aplican a todo el request (no por archivo).
// fileSize / files / fields cortan el DoS de multipart enorme que
// tenían las 1.4.5-lts.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES,
    fields: 5,
    parts: 10,
    fieldNameSize: 100,
    fieldSize: 64 * 1024,
    fieldNestingDepth: 1,
    // El formulario no usa arrays. 0 rechaza índices > 0 (a[999999]).
    fieldArrayIndexLimit: 0,
    headerPairs: 100
  },
  fileFilter: (req, file, cb) => {
    if (!isAllowedMime(file.mimetype)) {
      return cb(new Error('Tipo de archivo no permitido. Solo imagen, video o audio.'));
    }
    cb(null, true);
  }
});

function uploadErrorMessage(err) {
  if (!err) return 'No se pudo subir el archivo';
  if (err.code === 'LIMIT_FILE_SIZE') {
    return `El archivo supera el límite de ${MAX_FILE_SIZE_MB}MB`;
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return 'Solo se permite un archivo por solicitud';
  }
  if (
    err.code === 'LIMIT_FIELD_COUNT' ||
    err.code === 'LIMIT_FIELD_VALUE' ||
    err.code === 'LIMIT_FIELD_KEY' ||
    err.code === 'LIMIT_PART_COUNT' ||
    err.code === 'LIMIT_FIELD_NESTING' ||
    err.code === 'LIMIT_FIELD_ARRAY_INDEX' ||
    err.code === 'LIMIT_HEADER_PAIRS' ||
    err.code === 'INVALID_FIELD_NAME' ||
    err.code === 'MISSING_FIELD_NAME'
  ) {
    return 'La solicitud de subida no es válida';
  }
  return err.message;
}

router.use(advertiserAuth);

// POST /api/ads/uploads/creative — campo de archivo: "file"
router.post('/creative', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: uploadErrorMessage(err) });
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
