// routes/ads/leads.js
// Endpoint público (sin auth) para el formulario de contacto de las
// páginas de marketing (landing, anunciantes, venues). Reemplaza el
// mailto: — captura el lead directo en la base de datos.

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { leadsLimiter } = require('../../middleware/rateLimits');
const { notifyNewLead } = require('../../lib/email');

router.use(leadsLimiter);

// Validación simple de email (suficiente para filtrar basura obvia,
// no pretende ser RFC-perfecta).
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /api/ads/leads — crear un lead nuevo
router.post('/', async (req, res) => {
  const { name, email, company, phone, role, message, source_page } = req.body;

  if (!name || !email || !role) {
    return res.status(400).json({ error: 'name, email y role son requeridos' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }
  const validRoles = ['advertiser', 'venue', 'other'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role inválido. Usar: ${validRoles.join(', ')}` });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('bitads_leads')
      .insert({
        name, email,
        company: company || null,
        phone: phone || null,
        role,
        message: message || null,
        source_page: source_page || null,
        status: 'new'
      })
      .select()
      .single();

    if (error) throw error;

    notifyNewLead('mario@bitproximity.com', name, email, role, source_page)
      .catch(e => console.warn('[ads/leads] no se pudo enviar notificación de lead', e));

    res.status(201).json({ ok: true, lead: { id: data.id } });
  } catch (err) {
    console.error('[ads/leads] POST /', err);
    res.status(500).json({ error: 'No se pudo enviar el formulario. Intenta de nuevo en un momento.' });
  }
});

module.exports = router;
