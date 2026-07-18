// routes/ads/campaigns.js
// Gestión de campañas, creativos y booking — dashboard del advertiser.
// Auth: header 'x-bitads-api-key' (resuelto por middleware/advertiserAuth.js).

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const advertiserAuth = require('../../middleware/advertiserAuth');
const { notifySlotBooked } = require('../../lib/email');

router.use(advertiserAuth);

// GET /api/ads/campaigns
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('ad_campaigns')
      .select('*, ad_creatives(*), ad_campaign_slots(*)')
      .eq('advertiser_id', req.advertiserId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ campaigns: data });
  } catch (err) {
    console.error('[ads/campaigns] GET /', err);
    res.status(500).json({ error: 'No se pudieron obtener las campañas' });
  }
});

// POST /api/ads/campaigns
router.post('/', async (req, res) => {
  const { name, start_date, end_date, targeting, budget_total, frequency_cap_per_day } = req.body;

  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, start_date y end_date son requeridos' });
  }
  if (new Date(end_date) < new Date(start_date)) {
    return res.status(400).json({ error: 'end_date no puede ser anterior a start_date' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('ad_campaigns')
      .insert({
        advertiser_id: req.advertiserId,
        name,
        start_date,
        end_date,
        targeting: targeting || {},
        budget_total: budget_total ?? null,
        frequency_cap_per_day: frequency_cap_per_day ?? 0,
        status: 'draft'
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ campaign: data });
  } catch (err) {
    console.error('[ads/campaigns] POST /', err);
    res.status(500).json({ error: 'No se pudo crear la campaña' });
  }
});

// PATCH /api/ads/campaigns/:id/status
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ['draft', 'pending_review', 'approved', 'active', 'paused', 'completed', 'rejected'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status inválido. Usar: ${validStatuses.join(', ')}` });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('ad_campaigns')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('advertiser_id', req.advertiserId) // <- límite de seguridad real
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ campaign: data });
  } catch (err) {
    console.error('[ads/campaigns] PATCH /:id/status', err);
    res.status(500).json({ error: 'No se pudo actualizar el estado' });
  }
});

// POST /api/ads/campaigns/:id/creatives
router.post('/:id/creatives', async (req, res) => {
  const { id } = req.params;
  const { creative_type, file_url, duration_sec, dimensions, applicable_slot_types, destination_url } = req.body;

  const validCreativeTypes = ['image', 'video', 'audio', 'html5'];
  if (!validCreativeTypes.includes(creative_type)) {
    return res.status(400).json({ error: `creative_type inválido. Usar: ${validCreativeTypes.join(', ')}` });
  }
  if (!file_url) return res.status(400).json({ error: 'file_url es requerido' });
  if (!Array.isArray(applicable_slot_types) || applicable_slot_types.length === 0) {
    return res.status(400).json({ error: 'applicable_slot_types debe ser un array no vacío' });
  }
  if (['video', 'audio'].includes(creative_type) && !duration_sec) {
    return res.status(400).json({ error: 'duration_sec es requerido para video/audio' });
  }

  try {
    const { data: campaign, error: campaignErr } = await supabaseAdmin
      .from('ad_campaigns')
      .select('id')
      .eq('id', id)
      .eq('advertiser_id', req.advertiserId) // <- confirma ownership antes de insertar
      .single();

    if (campaignErr || !campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

    const { data, error } = await supabaseAdmin
      .from('ad_creatives')
      .insert({
        campaign_id: id,
        creative_type,
        file_url,
        duration_sec: duration_sec || null,
        dimensions: dimensions || null,
        destination_url: destination_url || null,
        applicable_slot_types,
        review_status: 'pending'
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ creative: data });
  } catch (err) {
    console.error('[ads/campaigns] POST /:id/creatives', err);
    res.status(500).json({ error: 'No se pudo subir el creativo' });
  }
});

// POST /api/ads/campaigns/:id/book — reservar un slot (por su id público, visible en un marketplace de slots)
router.post('/:id/book', async (req, res) => {
  const { id } = req.params;
  const { slot_id, agreed_price, pricing_model, weight } = req.body;

  if (!slot_id || !agreed_price || !pricing_model) {
    return res.status(400).json({ error: 'slot_id, agreed_price y pricing_model son requeridos' });
  }
  if (!['cpm', 'daily_fixed'].includes(pricing_model)) {
    return res.status(400).json({ error: "pricing_model debe ser 'cpm' o 'daily_fixed'" });
  }

  try {
    const { data: campaign, error: campaignErr } = await supabaseAdmin
      .from('ad_campaigns')
      .select('id, name')
      .eq('id', id)
      .eq('advertiser_id', req.advertiserId)
      .single();

    if (campaignErr || !campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

    const { data: slot, error: slotErr } = await supabaseAdmin
      .from('ad_slots')
      .select('id, status, external_venue_name, bitads_tenants(name, contact_email)')
      .eq('id', slot_id)
      .eq('status', 'active')
      .single();

    if (slotErr || !slot) return res.status(404).json({ error: 'Slot no encontrado o inactivo' });

    const { data, error } = await supabaseAdmin
      .from('ad_campaign_slots')
      .insert({
        campaign_id: id,
        slot_id,
        agreed_price,
        pricing_model,
        weight: weight ?? 1,
        status: 'scheduled'
      })
      .select()
      .single();

    if (error) throw error;

    const tenant = slot.bitads_tenants;
    if (tenant?.contact_email) {
      notifySlotBooked(tenant.contact_email, tenant.name, slot.external_venue_name, campaign.name || 'Una campaña')
        .catch(e => console.warn('[ads/campaigns] no se pudo enviar notificación de reserva', e));
    }

    res.status(201).json({ booking: data });
  } catch (err) {
    console.error('[ads/campaigns] POST /:id/book', err);
    res.status(500).json({ error: 'No se pudo reservar el slot (¿ya está reservado por esta campaña?)' });
  }
});

// PATCH /api/ads/campaigns/:id/book/:bookingId/cancel — cancelar una reserva propia
router.patch('/:id/book/:bookingId/cancel', async (req, res) => {
  const { id, bookingId } = req.params;

  try {
    const { data: campaign, error: campaignErr } = await supabaseAdmin
      .from('ad_campaigns')
      .select('id')
      .eq('id', id)
      .eq('advertiser_id', req.advertiserId)
      .single();

    if (campaignErr || !campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

    const { data, error } = await supabaseAdmin
      .from('ad_campaign_slots')
      .update({ status: 'cancelled' })
      .eq('id', bookingId)
      .eq('campaign_id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Reserva no encontrada' });

    res.json({ booking: data });
  } catch (err) {
    console.error('[ads/campaigns] PATCH /:id/book/:bookingId/cancel', err);
    res.status(500).json({ error: 'No se pudo cancelar la reserva' });
  }
});

module.exports = router;
