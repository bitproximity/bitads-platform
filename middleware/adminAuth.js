// middleware/adminAuth.js
// Auth de administrador (vos). NO es una cuenta de tenant ni de
// advertiser — es una key secreta propia, guardada como env var,
// que nunca se expone a usuarios normales de la plataforma.
//
// Env var requerida (Railway, servicio bitads-api):
//   ADMIN_API_KEY=<generá un valor largo y random, ej: openssl rand -hex 32>

const crypto = require('crypto');

// Compara en tiempo constante aunque las longitudes difieran.
// Se hashea ambos lados a SHA-256 (32 bytes) y recién ahí se usa
// timingSafeEqual, que exige buffers del mismo tamaño. Así un !==
// no puede cortar en el primer carácter distinto y filtrar el secreto.
function timingSafeEqualString(provided, expected) {
  const providedHash = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

module.exports = function adminAuth(req, res, next) {
  const key = req.headers['x-bitads-admin-key'];

  if (!process.env.ADMIN_API_KEY) {
    console.error('[adminAuth] ADMIN_API_KEY no está configurada en las env vars');
    return res.status(500).json({ error: 'Admin no configurado' });
  }

  if (typeof key !== 'string' || !timingSafeEqualString(key, process.env.ADMIN_API_KEY)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  next();
};
