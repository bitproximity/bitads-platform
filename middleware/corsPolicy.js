// middleware/corsPolicy.js
//
// CORS en dos políticas:
//
// 1. Player público (BitSignage, BitMusic, portal WiFi, widgets web).
//    Esos clientes viven en dominios de Bit Proximity que no controlamos,
//    así que /api/ads/rotation/* acepta cualquier origen. Ver
//    routes/ads/rotation.js y routes/ads/bitads-client.js.
//
// 2. El resto de la API (admin, dashboards de tenant/anunciante, signup,
//    marketplace, leads, uploads) usa un allowlist explícito.
//
// Env var (Railway, servicio bitads-api), opcional:
//   CORS_ALLOWED_ORIGINS=https://admin.bitadsapp.com,https://bitadsapp.com
//
// Si no está definida, el default son los frontends que este repo ya
// trata como legítimos:
//   https://admin.bitadsapp.com  — panel (signup.js, lib/email.js)
//   https://bitadsapp.com         — sitio del producto (dominio de
//                                   api.bitadsapp.com y de noreply@)
//   https://www.bitadsapp.com     — el mismo sitio con www
//
// Si se define, REEMPLAZA esa lista: hay que incluir cada origen
// completo (esquema + host [+ puerto]). No uses "*".
// Para desarrollo local, agregá el origen del frontend, por ejemplo
// http://localhost:5173.

const path = require('path');
const cors = require('cors');

const DEFAULT_ALLOWED_ORIGINS = [
  'https://admin.bitadsapp.com',
  'https://bitadsapp.com',
  'https://www.bitadsapp.com'
];

const API_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];

// req.path deja %2e y %2f sin decodificar. Un proxy que sí los resuelva
// vería otro path, así que la decisión de CORS usa el path canónico.
function normalizeRequestPath(urlPath) {
  let value = urlPath || '/';
  try {
    value = decodeURIComponent(value);
  } catch {
    return '/';
  }
  if (value.includes('\0')) return '/';
  const normalized = path.posix.normalize(value);
  if (!normalized.startsWith('/')) return '/';
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

// Todo el router de rotación es la superficie pública del player.
function isPublicPlayerRequest(req) {
  const requestPath = normalizeRequestPath(req.path);
  return requestPath === '/api/ads/rotation' || requestPath.startsWith('/api/ads/rotation/');
}

function parseOriginList(raw) {
  return String(raw)
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function allowedOrigins() {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (raw == null || raw.trim() === '') return DEFAULT_ALLOWED_ORIGINS.slice();
  return parseOriginList(raw);
}

// Abierto a cualquier origen. Igual que el cors() global anterior,
// pero solo para el player.
const publicPlayerCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS']
});

const apiCors = cors({
  origin(origin, callback) {
    // Sin header Origin: curl, server-to-server, same-origin navegación.
    if (!origin) return callback(null, true);
    if (allowedOrigins().includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: API_METHODS
});

function corsPolicy(req, res, next) {
  if (isPublicPlayerRequest(req)) return publicPlayerCors(req, res, next);
  return apiCors(req, res, next);
}

module.exports = { corsPolicy };
