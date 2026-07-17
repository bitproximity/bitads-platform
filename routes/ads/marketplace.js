// routes/ads/marketplace.js
// Listado público de inventario disponible para reservar. Sin auth
// (cualquier advertiser potencial puede explorar antes de crear cuenta).
// Solo expone lo mínimo necesario para decidir una reserva — nunca
// datos del tenant dueño (email, api_key, etc.)

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');

// GET /api/ads/marketplace/slots?slot_type=screen&country=PA&max_price=50&page=1
router.get('/slots', async (req, res) => {
  const { slot_type, country, max_price, search, page } = req.query;
  const pageSize = 20;
  const pageNum = Math.max(parseInt(page) || 1, 1);

  try {
    let query = supabaseAdmin
      .from('ad_slots')
      .select('id, slot_type, external_venue_name, country, specs, base_price_cpm, base_price_daily, created_at', { count: 'exact' })
      .eq('status', 'active')
      .eq('is_monetizable', true);

    if (slot_type) {
      const validTypes = ['screen', 'wifi_portal', 'audio', 'web_banner'];
      if (!validTypes.includes(slot_type)) {
        return res.status(400).json({ error: `slot_type inválido. Usar: ${validTypes.join(', ')}` });
      }
      query = query.eq('slot_type', slot_type);
    }
    if (country) query = query.eq('country', country);
    if (search) query = query.ilike('external_venue_name', `%${search}%`);
    if (max_price) {
      const maxP = Number(max_price);
      if (!isNaN(maxP)) {
        // matchea si CUALQUIERA de los dos modelos de precio está bajo el máximo
        query = query.or(`base_price_cpm.lte.${maxP},base_price_daily.lte.${maxP}`);
      }
    }

    const from = (pageNum - 1) * pageSize;
    const to = from + pageSize - 1;
    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      slots: data,
      pagination: { page: pageNum, page_size: pageSize, total: count, total_pages: Math.ceil((count || 0) / pageSize) }
    });
  } catch (err) {
    console.error('[ads/marketplace] GET /slots', err);
    res.status(500).json({ error: 'No se pudo obtener el inventario disponible' });
  }
});

// GET /api/ads/marketplace/countries — países con inventario disponible (para poblar el filtro)
router.get('/countries', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('ad_slots')
      .select('country')
      .eq('status', 'active')
      .eq('is_monetizable', true)
      .not('country', 'is', null);

    if (error) throw error;
    const unique = [...new Set(data.map(r => r.country))].sort();
    res.json({ countries: unique });
  } catch (err) {
    console.error('[ads/marketplace] GET /countries', err);
    res.status(500).json({ error: 'No se pudieron obtener los países' });
  }
});

module.exports = router;
