// routes/ads/admin.js
// Panel de admin (solo vos, via ADMIN_API_KEY). Acá se gestiona:
// 1. ¿El anunciante ya te pagó a vos por esta reserva?
// 2. Tu comisión sobre esa reserva (caso por caso, la definís vos).
// 3. ¿Ya le pagaste al venue su parte (revenue menos tu comisión)?
//
// El tenant NUNCA controla esto — solo ve el resultado (payout_status)
// desde su propio reporte, de forma read-only.

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const adminAuth = require('../../middleware/adminAuth');

router.use(adminAuth);

// GET /api/ads/admin/bookings — todas las reservas de la plataforma,
// con el estado de cobro/payout y el monto calculado.
router.get('/bookings', async (req, res) => {
  try {
    const { data: bookings, error } = await supabaseAdmin
      .from('ad_campaign_slots')
      .select(`
        id, agreed_price, pricing_model, status, commission_pct,
        payment_status, payout_status, payout_notes,
        ad_campaigns(name, ads_advertisers(name, contact_email)),
        ad_slots(external_venue_name, slot_type, bitads_tenants(name, contact_email))
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // impresiones por booking, para calcular el monto real (igual criterio que reporting.js)
    const bookingIds = bookings.map(b => b.id);
    let impressions = [];
    if (bookingIds.length > 0) {
      const { data: imps, error: impErr } = await supabaseAdmin
        .from('ad_impressions')
        .select('campaign_slot_id, occurred_at, estimated_count')
        .in('campaign_slot_id', bookingIds);
      if (impErr) throw impErr;
      impressions = imps;
    }

    const enriched = bookings.map(b => {
      const bImps = impressions.filter(i => i.campaign_slot_id === b.id);
      const count = bImps.reduce((sum, i) => sum + (i.estimated_count || 0), 0);
      let grossRevenue = 0;
      if (b.pricing_model === 'cpm') {
        grossRevenue = (count / 1000) * b.agreed_price;
      } else {
        const daysActive = new Set(bImps.map(i => i.occurred_at.slice(0, 10))).size;
        grossRevenue = daysActive * b.agreed_price;
      }
      grossRevenue = Math.round(grossRevenue * 100) / 100;
      const commission = Math.round(grossRevenue * (b.commission_pct / 100) * 100) / 100;
      const venuePayout = Math.round((grossRevenue - commission) * 100) / 100;

      return {
        id: b.id,
        campaign_name: b.ad_campaigns?.name,
        advertiser_name: b.ad_campaigns?.ads_advertisers?.name,
        advertiser_email: b.ad_campaigns?.ads_advertisers?.contact_email,
        venue_name: b.ad_slots?.external_venue_name,
        slot_type: b.ad_slots?.slot_type,
        tenant_name: b.ad_slots?.bitads_tenants?.name,
        tenant_email: b.ad_slots?.bitads_tenants?.contact_email,
        booking_status: b.status,
        impressions: count,
        gross_revenue: grossRevenue,
        commission_pct: b.commission_pct,
        commission_amount: commission,
        venue_payout: venuePayout,
        payment_status: b.payment_status,   // ¿te pagó el anunciante?
        payout_status: b.payout_status,     // ¿le pagaste al venue?
        payout_notes: b.payout_notes
      };
    });

    res.json({ bookings: enriched });
  } catch (err) {
    console.error('[admin] GET /bookings', err);
    res.status(500).json({ error: 'No se pudieron obtener las reservas' });
  }
});

// PATCH /api/ads/admin/bookings/:id — actualizar comisión, pago del
// anunciante, y/o payout al venue. Todos los campos son opcionales,
// solo se actualiza lo que se manda.
router.patch('/bookings/:id', async (req, res) => {
  const { id } = req.params;
  const { commission_pct, payment_status, payout_status, payout_notes } = req.body;

  const updates = {};

  if (commission_pct !== undefined) {
    const pct = Number(commission_pct);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'commission_pct debe ser un número entre 0 y 100' });
    }
    updates.commission_pct = pct;
  }

  if (payment_status !== undefined) {
    if (!['pending', 'paid'].includes(payment_status)) {
      return res.status(400).json({ error: "payment_status debe ser 'pending' o 'paid'" });
    }
    updates.payment_status = payment_status;
  }

  if (payout_status !== undefined) {
    if (!['pending', 'paid'].includes(payout_status)) {
      return res.status(400).json({ error: "payout_status debe ser 'pending' o 'paid'" });
    }
    updates.payout_status = payout_status;
    updates.payout_at = payout_status === 'paid' ? new Date().toISOString() : null;
  }

  if (payout_notes !== undefined) {
    updates.payout_notes = payout_notes || null;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nada para actualizar' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('ad_campaign_slots')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Reserva no encontrada' });

    res.json({ booking: data });
  } catch (err) {
    console.error('[admin] PATCH /bookings/:id', err);
    res.status(500).json({ error: 'No se pudo actualizar la reserva' });
  }
});

module.exports = router;
