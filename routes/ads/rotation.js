// routes/ads/rotation.js
//
// Motor de ad-serving. Llamado por: BitSignage player, BitMusic player,
// WiFi captive portal, widgets web — desde DENTRO de Bit Proximity, pero
// como request HTTP pública normal, no como llamada interna.
//
// Auth: el slot_api_key va en la URL (lo copia Mario a mano en la config
// del screen/wifi_zone/canal de música, o vía un endpoint futuro). No
// requiere login de usuario porque el que llama es un player, no una persona.

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');

// GET /api/ads/rotation/:slotApiKey — próximo creativo a mostrar en ese slot
router.get('/:slotApiKey', async (req, res) => {
  const { slotApiKey } = req.params;

  try {
    const { data: slot, error: slotErr } = await supabaseAdmin
      .from('ad_slots')
      .select('*')
      .eq('slot_api_key', slotApiKey)
      .eq('status', 'active')
      .single();

    if (slotErr || !slot) {
      return res.status(404).json({ error: 'Slot no encontrado, inactivo, o api key inválida' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const currentHour = new Date().getHours();

    const { data: bookings, error: bookingsErr } = await supabaseAdmin
      .from('ad_campaign_slots')
      .select(`
        id, weight, status,
        ad_campaigns!inner(id, status, start_date, end_date, targeting, frequency_cap_per_day)
      `)
      .eq('slot_id', slot.id)
      .in('status', ['scheduled', 'running'])
      .eq('ad_campaigns.status', 'active')
      .lte('ad_campaigns.start_date', today)
      .gte('ad_campaigns.end_date', today);

    if (bookingsErr) throw bookingsErr;
    if (!bookings || bookings.length === 0) {
      return res.status(204).send(); // sin anuncios elegibles -> el player muestra su contenido normal
    }

    const eligible = [];
    for (const booking of bookings) {
      const campaign = booking.ad_campaigns;
      const targeting = campaign.targeting || {};

      if (Array.isArray(targeting.dayparts) && targeting.dayparts.length > 0) {
        const inDaypart = targeting.dayparts.some(range => {
          const [start, end] = range.split('-').map(Number);
          return currentHour >= start && currentHour < end;
        });
        if (!inDaypart) continue;
      }

      if (campaign.frequency_cap_per_day > 0) {
        const { count } = await supabaseAdmin
          .from('ad_impressions')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_slot_id', booking.id)
          .gte('occurred_at', `${today}T00:00:00Z`);

        if (count >= campaign.frequency_cap_per_day) continue;
      }

      const { data: creatives } = await supabaseAdmin
        .from('ad_creatives')
        .select('*')
        .eq('campaign_id', campaign.id)
        .eq('review_status', 'approved')
        .contains('applicable_slot_types', [slot.slot_type]);

      if (!creatives || creatives.length === 0) continue;

      eligible.push({ booking, creative: creatives[0], weight: booking.weight || 1 });
    }

    if (eligible.length === 0) return res.status(204).send();

    const totalWeight = eligible.reduce((sum, e) => sum + e.weight, 0);
    let rand = Math.random() * totalWeight;
    let chosen = eligible[0];
    for (const e of eligible) {
      rand -= e.weight;
      if (rand <= 0) { chosen = e; break; }
    }

    await supabaseAdmin.from('ad_impressions').insert({
      campaign_slot_id: chosen.booking.id,
      creative_id: chosen.creative.id,
      estimated_count: 1
    });

    res.json({
      creative: {
        id: chosen.creative.id,
        type: chosen.creative.creative_type,
        file_url: chosen.creative.file_url,
        duration_sec: chosen.creative.duration_sec,
        dimensions: chosen.creative.dimensions
      },
      campaign_slot_id: chosen.booking.id
    });
  } catch (err) {
    console.error('[ads/rotation] GET /:slotApiKey', err);
    res.status(500).json({ error: 'Error en el motor de rotación' });
  }
});

// POST /api/ads/rotation/impression — reportar conteo estimado real
// (tráfico frente a pantalla, conexiones wifi, plays de audio completos)
router.post('/impression', async (req, res) => {
  const { campaign_slot_id, creative_id, estimated_count, metadata } = req.body;

  if (!campaign_slot_id || !creative_id) {
    return res.status(400).json({ error: 'campaign_slot_id y creative_id son requeridos' });
  }

  try {
    const { error } = await supabaseAdmin.from('ad_impressions').insert({
      campaign_slot_id,
      creative_id,
      estimated_count: estimated_count ?? 1,
      metadata: metadata || {}
    });

    if (error) throw error;
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[ads/rotation] POST /impression', err);
    res.status(500).json({ error: 'No se pudo registrar la impresión' });
  }
});

module.exports = router;
