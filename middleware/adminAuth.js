// middleware/adminAuth.js
// Auth de administrador (vos). NO es una cuenta de tenant ni de
// advertiser — es una key secreta propia, guardada como env var,
// que nunca se expone a usuarios normales de la plataforma.
//
// Env var requerida (Railway, servicio bitads-api):
//   ADMIN_API_KEY=<generá un valor largo y random, ej: openssl rand -hex 32>

module.exports = function adminAuth(req, res, next) {
  const key = req.headers['x-bitads-admin-key'];

  if (!process.env.ADMIN_API_KEY) {
    console.error('[adminAuth] ADMIN_API_KEY no está configurada en las env vars');
    return res.status(500).json({ error: 'Admin no configurado' });
  }

  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  next();
};
