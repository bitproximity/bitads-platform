// lib/supabaseClient.js
// Proyecto BitAds standalone — apunta al Supabase "bitads-db" propio.
//
// Env vars requeridas (Railway, servicio bitads-api):
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY=<service_role key de bitads-db>
//
// Un solo cliente, service_role, usado en TODA la app. El aislamiento
// tenant/advertiser NO se delega a RLS por sesión (ver nota en el schema
// sobre por qué eso es frágil con pgbouncer) — se hace explícitamente en
// cada query dentro de routes/ads/*.js, filtrando por el id resuelto en
// el middleware de auth.

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en las env vars de bitads-api');
}

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

module.exports = { supabaseAdmin };
