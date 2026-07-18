// middleware/tenantAuth.js
// Resuelve el header 'x-bitads-api-key' a un bitads_tenant_id.
// Usado en routes/ads/slots.js (dashboard del dueño del inventario).

const { supabaseAdmin } = require('../lib/supabaseClient');

module.exports = async function tenantAuth(req, res, next) {
  const apiKey = req.headers['x-bitads-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Falta el header x-bitads-api-key' });

  try {
    const { data: tenant, error } = await supabaseAdmin
      .from('bitads_tenants')
      .select('id, name, status, email_verified')
      .eq('api_key', apiKey)
      .single();

    if (error || !tenant) return res.status(401).json({ error: 'API key inválida' });
    if (!tenant.email_verified) return res.status(403).json({ error: 'Confirmá tu email antes de entrar. Revisá tu bandeja de entrada.' });
    if (tenant.status !== 'active') return res.status(403).json({ error: 'Cuenta suspendida' });

    req.bitadsTenantId = tenant.id;
    req.bitadsTenantName = tenant.name;
    next();
  } catch (err) {
    console.error('[tenantAuth]', err);
    res.status(500).json({ error: 'Error de autenticación' });
  }
};
