// server.js — entrypoint de bitads-api
const express = require('express');
const { corsPolicy } = require('./middleware/corsPolicy');

const app = express();

// Railway corre la app detrás de un proxy — sin esto, express-rate-limit
// no puede identificar la IP real del cliente (ve la IP del proxy para
// todos, lo que rompería el rate limiting).
app.set('trust proxy', 1);

// Abierto solo en el player público (/api/ads/rotation). El resto usa
// el allowlist de CORS_ALLOWED_ORIGINS (middleware/corsPolicy.js).
app.use(corsPolicy);
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'bitads-api' }));

app.use('/api/ads', require('./routes/ads'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`bitads-api escuchando en puerto ${PORT}`));
