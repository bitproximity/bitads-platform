// routes/ads/slots.js
// Gestión de inventario publicitario — dashboard del bitads_tenant.
// Auth: header 'x-bitads-api-key' (resuelto por middleware/tenantAuth.js).

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const tenantAuth = require('../../middleware/tenantAuth');

router.use(tenantAuth);

// GET /api/ads/slots — listar slots del tenant autenticado
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('ad_slots')
      .select('*')
      .eq('bitads_tenant_id', req.bitadsTenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ slots: data });
  } catch (err) {
    console.error('[ads/slots] GET /', err);
    res.status(500).json({ error: 'No se pudo obtener el inventario' });
  }
});

// POST /api/ads/slots — crear un nuevo slot publicitario
router.post('/', async (req, res) => {
  const {
    slot_type, external_venue_id, external_venue_name, external_resource_id,
    country, specs, max_ad_share_pct, base_price_cpm, base_price_daily
  } = req.body;

  const validTypes = ['screen', 'wifi_portal', 'audio', 'web_banner'];
  if (!slot_type || !validTypes.includes(slot_type)) {
    return res.status(400).json({ error: `slot_type inválido. Usar: ${validTypes.join(', ')}` });
  }
  if (!external_venue_id) {
    return res.status(400).json({ error: 'external_venue_id es requerido (referencia libre al venue en Bit Proximity)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('ad_slots')
      .insert({
        bitads_tenant_id: req.bitadsTenantId,
        slot_type,
        external_venue_id,
        external_venue_name: external_venue_name || null,
        external_resource_id: external_resource_id || null,
        country: country || null,
        specs: specs || {},
        max_ad_share_pct: max_ad_share_pct ?? 20.00,
        base_price_cpm: base_price_cpm ?? null,
        base_price_daily: base_price_daily ?? null,
        status: 'active'
      })
      .select()
      .single();

    if (error) throw error;
    // data.slot_api_key es el key que hay que copiar a la config del
    // screen/wifi_zone/canal de música en Bit Proximity
    res.status(201).json({ slot: data });
  } catch (err) {
    console.error('[ads/slots] POST /', err);
    res.status(500).json({ error: 'No se pudo crear el slot' });
  }
});

// PATCH /api/ads/slots/:id
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const allowedFields = ['status', 'max_ad_share_pct', 'base_price_cpm', 'base_price_daily', 'is_monetizable', 'specs', 'external_venue_name', 'country'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
  updates.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabaseAdmin
      .from('ad_slots')
      .update(updates)
      .eq('id', id)
      .eq('bitads_tenant_id', req.bitadsTenantId) // <- límite de seguridad real
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Slot no encontrado' });
    res.json({ slot: data });
  } catch (err) {
    console.error('[ads/slots] PATCH /:id', err);
    res.status(500).json({ error: 'No se pudo actualizar el slot' });
  }
});

// DELETE /api/ads/slots/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabaseAdmin
      .from('ad_slots')
      .delete()
      .eq('id', id)
      .eq('bitads_tenant_id', req.bitadsTenantId);

    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    console.error('[ads/slots] DELETE /:id', err);
    res.status(500).json({ error: 'No se pudo eliminar el slot' });
  }
});

module.exports = router;
