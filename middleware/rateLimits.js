// middleware/rateLimits.js
// Rate limiting para endpoints PÚBLICOS (sin auth) — son los que
// cualquiera puede golpear con un script y saturar de cuentas/leads falsos.
// Los endpoints autenticados (slots, campaigns, etc.) no lo necesitan con
// la misma urgencia porque ya requieren un api_key válido.

const rateLimit = require('express-rate-limit');

// Registro de cuentas: 5 intentos por IP cada 15 minutos.
// Suficiente para un usuario real que se equivoca un par de veces,
// insuficiente para un script generando cuentas en masa.
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de registro. Probá de nuevo en 15 minutos.' }
});

// Formulario de leads: 10 por IP cada 15 minutos.
const leadsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados envíos. Probá de nuevo en 15 minutos.' }
});

// Motor de rotación: es llamado por players reales muy seguido (cada
// pocos segundos por pantalla activa), así que el límite es mucho más
// alto — esto es para frenar abuso obvio, no tráfico legítimo.
const rotationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes.' }
});

module.exports = { signupLimiter, leadsLimiter, rotationLimiter };
