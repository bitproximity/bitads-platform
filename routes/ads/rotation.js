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
const { rotationLimiter } = require('../../middleware/rateLimits');

router.use(rotationLimiter);

// GET /api/ads/rotation/:slotApiKey — próximo creativo a mostrar en ese slot
router.get('/:slotApiKey', async (req, res) => {
  const { slotApiKey } = req.params;
  const deviceId = req.query.device_id || null; // opcional: hash de MAC address u otro id de dispositivo (NUNCA identificar personas)

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
      estimated_count: 1,
      metadata: deviceId ? { device_id: deviceId } : {}
    });

    let formFields = null;
    if (chosen.creative.creative_type === 'form') {
      const { data: fields } = await supabaseAdmin
        .from('ad_form_fields')
        .select('field_key, field_label, field_type, options, required')
        .eq('creative_id', chosen.creative.id)
        .order('display_order', { ascending: true });
      formFields = fields || [];
    }

    res.json({
      creative: {
        id: chosen.creative.id,
        type: chosen.creative.creative_type,
        file_url: chosen.creative.file_url,
        duration_sec: chosen.creative.duration_sec,
        dimensions: chosen.creative.dimensions,
        destination_url: chosen.creative.destination_url || null,
        form_fields: formFields
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

// POST /api/ads/rotation/form-response — envío de respuestas de un
// creativo tipo 'form' (captura de leads para el anunciante). Público,
// sin auth — lo llama el widget/portal donde se muestra el formulario.
router.post('/form-response', async (req, res) => {
  const { creative_id, campaign_slot_id, responses } = req.body;

  if (!creative_id || !responses || typeof responses !== 'object') {
    return res.status(400).json({ error: 'creative_id y responses son requeridos' });
  }

  try {
    // validar que el creativo existe y es tipo 'form', y traer los
    // campos requeridos para chequear que no falte ninguno obligatorio
    const { data: creative, error: creativeErr } = await supabaseAdmin
      .from('ad_creatives')
      .select('id, creative_type')
      .eq('id', creative_id)
      .single();

    if (creativeErr || !creative || creative.creative_type !== 'form') {
      return res.status(404).json({ error: 'Creativo tipo form no encontrado' });
    }

    const { data: fields } = await supabaseAdmin
      .from('ad_form_fields')
      .select('field_key, required')
      .eq('creative_id', creative_id);

    const missing = (fields || []).filter(f => f.required && !responses[f.field_key]);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Faltan campos requeridos: ${missing.map(f => f.field_key).join(', ')}` });
    }

    const { error } = await supabaseAdmin.from('ad_form_responses').insert({
      creative_id,
      campaign_slot_id: campaign_slot_id || null,
      responses
    });

    if (error) throw error;

    // el envío del formulario también cuenta como impresión/interacción
    if (campaign_slot_id) {
      await supabaseAdmin.from('ad_impressions').insert({
        campaign_slot_id,
        creative_id,
        estimated_count: 0,
        metadata: { form_submitted: true }
      });
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[ads/rotation] POST /form-response', err);
    res.status(500).json({ error: 'No se pudo enviar el formulario' });
  }
});

module.exports = router;
