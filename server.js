// server.js — entrypoint de bitads-api
const express = require('express');
const cors = require('cors');

const app = express();

// Railway corre la app detrás de un proxy — sin esto, express-rate-limit
// no puede identificar la IP real del cliente (ve la IP del proxy para
// todos, lo que rompería el rate limiting).
app.set('trust proxy', 1);

app.use(cors()); // el player llama desde Bit Proximity (otro dominio) -> CORS abierto en este endpoint público
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'bitads-api' }));

app.use('/api/ads', require('./routes/ads'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`bitads-api escuchando en puerto ${PORT}`));
