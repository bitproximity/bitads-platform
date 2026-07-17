// routes/ads/signup.js
// Registro self-serve. Público, sin auth (es el punto de entrada).
// Devuelve el api_key generado UNA sola vez en la respuesta — el
// usuario tiene que guardarlo, no hay forma de recuperarlo después
// (mismo criterio que cualquier API key: no se almacena en texto
// plano en ningún lado accesible, y no hay endpoint de "olvidé mi key").

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /api/ads/signup/tenant — crear cuenta de dueño de inventario
router.post('/tenant', async (req, res) => {
  const { name, contact_email } = req.body;

  if (!name || !contact_email) {
    return res.status(400).json({ error: 'name y contact_email son requeridos' });
  }
  if (!isValidEmail(contact_email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  try {
    // evitar duplicados obvios por email
    const { data: existing } = await supabaseAdmin
      .from('bitads_tenants')
      .select('id')
      .eq('contact_email', contact_email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Si perdiste tu API key, contactanos.' });
    }

    const { data, error } = await supabaseAdmin
      .from('bitads_tenants')
      .insert({ name, contact_email, status: 'active' })
      .select('id, name, api_key')
      .single();

    if (error) throw error;
    res.status(201).json({ tenant: data });
  } catch (err) {
    console.error('[ads/signup] POST /tenant', err);
    res.status(500).json({ error: 'No se pudo crear la cuenta' });
  }
});

// POST /api/ads/signup/advertiser — crear cuenta de anunciante
router.post('/advertiser', async (req, res) => {
  const { name, contact_email, industry } = req.body;

  if (!name || !contact_email) {
    return res.status(400).json({ error: 'name y contact_email son requeridos' });
  }
  if (!isValidEmail(contact_email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  try {
    const { data: existing } = await supabaseAdmin
      .from('ads_advertisers')
      .select('id')
      .eq('contact_email', contact_email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Si perdiste tu API key, contactanos.' });
    }

    const { data, error } = await supabaseAdmin
      .from('ads_advertisers')
      .insert({ name, contact_email, industry: industry || null, status: 'active' })
      .select('id, name, api_key')
      .single();

    if (error) throw error;
    res.status(201).json({ advertiser: data });
  } catch (err) {
    console.error('[ads/signup] POST /advertiser', err);
    res.status(500).json({ error: 'No se pudo crear la cuenta' });
  }
});

module.exports = router;
