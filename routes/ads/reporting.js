// routes/ads/reporting.js
// Reporting agregado para el advertiser (rendimiento de sus campañas)
// y para el tenant (rendimiento de su inventario).

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const advertiserAuth = require('../../middleware/advertiserAuth');
const tenantAuth = require('../../middleware/tenantAuth');

// GET /api/ads/reporting/campaigns/:id — resumen de una campaña del advertiser autenticado
router.get('/campaigns/:id', advertiserAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from('ad_campaigns')
      .select('id, name, budget_total, start_date, end_date, status')
      .eq('id', id)
      .eq('advertiser_id', req.advertiserId)
      .single();

    if (campErr || !campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

    const { data: bookings, error: bookErr } = await supabaseAdmin
      .from('ad_campaign_slots')
      .select('id, slot_id, agreed_price, pricing_model, ad_slots(slot_type, external_venue_name, country)')
      .eq('campaign_id', id);
    if (bookErr) throw bookErr;

    const bookingIds = bookings.map(b => b.id);
    let impressions = [];
    if (bookingIds.length > 0) {
      const { data: imps, error: impErr } = await supabaseAdmin
        .from('ad_impressions')
        .select('campaign_slot_id, creative_id, occurred_at, estimated_count, metadata')
        .in('campaign_slot_id', bookingIds);
      if (impErr) throw impErr;
      impressions = imps;
    }

    // mapa de creativos de esta campaña, para poder calcular completion rate de audio
    const { data: creatives, error: creativesErr } = await supabaseAdmin
      .from('ad_creatives')
      .select('id, creative_type, duration_sec')
      .eq('campaign_id', id);
    if (creativesErr) throw creativesErr;
    const creativeById = Object.fromEntries((creatives || []).map(c => [c.id, c]));

    // ---- completion rate de audio ----
    // solo cuenta impresiones de creativos tipo 'audio' que trajeron
    // metadata.play_duration_sec (el player todavía no lo manda por
    // defecto — esto queda listo para cuando lo empiece a reportar)
    const audioImpsWithData = impressions.filter(i => {
      const creative = creativeById[i.creative_id];
      return creative && creative.creative_type === 'audio' && i.metadata && typeof i.metadata.play_duration_sec === 'number';
    });
    let audio_completion_rate = null;
    if (audioImpsWithData.length > 0) {
      const ratios = audioImpsWithData.map(i => {
        const creative = creativeById[i.creative_id];
        const full = creative.duration_sec || i.metadata.play_duration_sec;
        return Math.min(i.metadata.play_duration_sec / full, 1);
      });
      audio_completion_rate = Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 1000) / 10; // %
    }

    // ---- reach (personas/dispositivos únicos) ----
    // solo cuenta si el player mandó metadata.device_id — no inventamos
    // el número si no hay dato real detrás.
    const withDeviceId = impressions.filter(i => i.metadata && i.metadata.device_id);
    const unique_reach = withDeviceId.length > 0
      ? new Set(withDeviceId.map(i => i.metadata.device_id)).size
      : null;
    const reach_coverage_pct = impressions.length > 0
      ? Math.round((withDeviceId.length / impressions.length) * 1000) / 10
      : 0;

    // agregado total + por slot + spend estimado
    let totalImpressions = 0;
    let totalSpend = 0;
    let totalClicks = 0;

    const perSlot = bookings.map(b => {
      const slotImps = impressions.filter(i => i.campaign_slot_id === b.id);
      const count = slotImps.reduce((sum, i) => sum + (i.estimated_count || 0), 0);
      const clicks = slotImps.filter(i => i.metadata && i.metadata.clicked).length;
      // spend: cpm = (impresiones/1000) * precio ; daily_fixed = precio * días con al menos 1 impresión
      let spend = 0;
      if (b.pricing_model === 'cpm') {
        spend = (count / 1000) * b.agreed_price;
      } else {
        const daysActive = new Set(slotImps.map(i => i.occurred_at.slice(0, 10))).size;
        spend = daysActive * b.agreed_price;
      }
      totalImpressions += count;
      totalSpend += spend;
      totalClicks += clicks;

      return {
        slot_id: b.slot_id,
        slot_type: b.ad_slots?.slot_type,
        venue_name: b.ad_slots?.external_venue_name,
        country: b.ad_slots?.country,
        pricing_model: b.pricing_model,
        agreed_price: b.agreed_price,
        impressions: count,
        clicks,
        estimated_spend: Math.round(spend * 100) / 100
      };
    });

    // serie diaria (últimos 30 días con datos)
    const byDay = {};
    impressions.forEach(i => {
      const day = i.occurred_at.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + (i.estimated_count || 0);
    });
    const daily_series = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, impressions: count }));

    res.json({
      campaign,
      totals: {
        impressions: totalImpressions,
        clicks: totalClicks,
        estimated_spend: Math.round(totalSpend * 100) / 100,
        budget_total: campaign.budget_total,
        budget_used_pct: campaign.budget_total ? Math.round((totalSpend / campaign.budget_total) * 1000) / 10 : null,
        audio_completion_rate, // % promedio, null si no hay datos todavía
        unique_reach,          // dispositivos únicos, null si no hay device_id reportado
        reach_coverage_pct     // % de impresiones que sí traían device_id (transparencia sobre qué tan completo es el dato)
      },
      per_slot: perSlot,
      daily_series
    });
  } catch (err) {
    console.error('[ads/reporting] GET /campaigns/:id', err);
    res.status(500).json({ error: 'No se pudo obtener el reporte' });
  }
});

// GET /api/ads/reporting/slots/:id — resumen de un slot del tenant autenticado
router.get('/slots/:id', tenantAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const { data: slot, error: slotErr } = await supabaseAdmin
      .from('ad_slots')
      .select('id, slot_type, external_venue_name, country')
      .eq('id', id)
      .eq('bitads_tenant_id', req.bitadsTenantId)
      .single();

    if (slotErr || !slot) return res.status(404).json({ error: 'Slot no encontrado' });

    const { data: bookings, error: bookErr } = await supabaseAdmin
      .from('ad_campaign_slots')
      .select('id, agreed_price, pricing_model, ad_campaigns(name)')
      .eq('slot_id', id);
    if (bookErr) throw bookErr;

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

    let totalImpressions = 0;
    let totalRevenue = 0;
    const perCampaign = bookings.map(b => {
      const bImps = impressions.filter(i => i.campaign_slot_id === b.id);
      const count = bImps.reduce((sum, i) => sum + (i.estimated_count || 0), 0);
      let revenue = 0;
      if (b.pricing_model === 'cpm') {
        revenue = (count / 1000) * b.agreed_price;
      } else {
        const daysActive = new Set(bImps.map(i => i.occurred_at.slice(0, 10))).size;
        revenue = daysActive * b.agreed_price;
      }
      totalImpressions += count;
      totalRevenue += revenue;
      return {
        campaign_name: b.ad_campaigns?.name,
        impressions: count,
        estimated_revenue: Math.round(revenue * 100) / 100
      };
    });

    res.json({
      slot,
      totals: { impressions: totalImpressions, estimated_revenue: Math.round(totalRevenue * 100) / 100 },
      per_campaign: perCampaign
    });
  } catch (err) {
    console.error('[ads/reporting] GET /slots/:id', err);
    res.status(500).json({ error: 'No se pudo obtener el reporte del slot' });
  }
});

module.exports = router;
