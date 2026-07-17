// routes/ads/moderation.js
// Moderación de creativos, del lado del tenant (dueño del inventario).
// Un tenant solo puede ver/moderar creativos de campañas que reservaron
// AL MENOS UNO de sus slots — no ve creativos de campañas ajenas a su
// inventario, aunque esas campañas existan en el sistema.

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const tenantAuth = require('../../middleware/tenantAuth');

router.use(tenantAuth);

// Helper: devuelve los campaign_id que reservaron algún slot de este tenant
async function campaignIdsForTenant(tenantId) {
  const { data: slots, error: slotsErr } = await supabaseAdmin
    .from('ad_slots')
    .select('id')
    .eq('bitads_tenant_id', tenantId);
  if (slotsErr) throw slotsErr;
  const slotIds = (slots || []).map(s => s.id);
  if (slotIds.length === 0) return [];

  const { data: bookings, error: bookingsErr } = await supabaseAdmin
    .from('ad_campaign_slots')
    .select('campaign_id')
    .in('slot_id', slotIds);
  if (bookingsErr) throw bookingsErr;

  return [...new Set((bookings || []).map(b => b.campaign_id))];
}

// GET /api/ads/moderation/pending — creativos pendientes de revisión
router.get('/pending', async (req, res) => {
  try {
    const campaignIds = await campaignIdsForTenant(req.bitadsTenantId);
    if (campaignIds.length === 0) return res.json({ creatives: [] });

    const { data, error } = await supabaseAdmin
      .from('ad_creatives')
      .select('*, ad_campaigns(id, name, advertiser_id)')
      .in('campaign_id', campaignIds)
      .eq('review_status', 'pending')
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ creatives: data });
  } catch (err) {
    console.error('[ads/moderation] GET /pending', err);
    res.status(500).json({ error: 'No se pudieron obtener los creativos pendientes' });
  }
});

// GET /api/ads/moderation/history — ya revisados (aprobados/rechazados), para referencia
router.get('/history', async (req, res) => {
  try {
    const campaignIds = await campaignIdsForTenant(req.bitadsTenantId);
    if (campaignIds.length === 0) return res.json({ creatives: [] });

    const { data, error } = await supabaseAdmin
      .from('ad_creatives')
      .select('*, ad_campaigns(id, name)')
      .in('campaign_id', campaignIds)
      .in('review_status', ['approved', 'rejected'])
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ creatives: data });
  } catch (err) {
    console.error('[ads/moderation] GET /history', err);
    res.status(500).json({ error: 'No se pudo obtener el historial' });
  }
});

// PATCH /api/ads/moderation/:creativeId — aprobar o rechazar
router.patch('/:creativeId', async (req, res) => {
  const { creativeId } = req.params;
  const { status, rejection_reason } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "status debe ser 'approved' o 'rejected'" });
  }
  if (status === 'rejected' && !rejection_reason) {
    return res.status(400).json({ error: 'rejection_reason es requerido al rechazar' });
  }

  try {
    // verificar que este creativo pertenece a una campaña que reservó
    // un slot de este tenant (el límite de seguridad real, en código)
    const campaignIds = await campaignIdsForTenant(req.bitadsTenantId);

    const { data: creative, error: fetchErr } = await supabaseAdmin
      .from('ad_creatives')
      .select('id, campaign_id')
      .eq('id', creativeId)
      .single();

    if (fetchErr || !creative) return res.status(404).json({ error: 'Creativo no encontrado' });
    if (!campaignIds.includes(creative.campaign_id)) {
      return res.status(403).json({ error: 'Este creativo no corresponde a tu inventario' });
    }

    const { data, error } = await supabaseAdmin
      .from('ad_creatives')
      .update({
        review_status: status,
        rejection_reason: status === 'rejected' ? rejection_reason : null
      })
      .eq('id', creativeId)
      .select()
      .single();

    if (error) throw error;
    res.json({ creative: data });
  } catch (err) {
    console.error('[ads/moderation] PATCH /:creativeId', err);
    res.status(500).json({ error: 'No se pudo actualizar el estado del creativo' });
  }
});

module.exports = router;
