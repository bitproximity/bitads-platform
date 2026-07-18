// middleware/advertiserAuth.js
// Resuelve el header 'x-bitads-api-key' a un advertiser_id.
// Usado en routes/ads/campaigns.js (dashboard del anunciante).

const { supabaseAdmin } = require('../lib/supabaseClient');

module.exports = async function advertiserAuth(req, res, next) {
  const apiKey = req.headers['x-bitads-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Falta el header x-bitads-api-key' });

  try {
    const { data: advertiser, error } = await supabaseAdmin
      .from('ads_advertisers')
      .select('id, name, status, email_verified')
      .eq('api_key', apiKey)
      .single();

    if (error || !advertiser) return res.status(401).json({ error: 'API key inválida' });
    if (!advertiser.email_verified) return res.status(403).json({ error: 'Confirmá tu email antes de entrar. Revisá tu bandeja de entrada.' });
    if (advertiser.status !== 'active') return res.status(403).json({ error: 'Cuenta suspendida' });

    req.advertiserId = advertiser.id;
    req.advertiserName = advertiser.name;
    next();
  } catch (err) {
    console.error('[advertiserAuth]', err);
    res.status(500).json({ error: 'Error de autenticación' });
  }
};
