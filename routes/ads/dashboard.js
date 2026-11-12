// routes/ads/dashboard.js
// Endpoints del dashboard v2. Archivo NUEVO e independiente: no modifica ni
// reemplaza ninguna ruta existente. Se monta con una sola línea en index.js:
//     router.use('/dashboard', require('./dashboard'));
//
// Diferencia clave con /reporting y /admin/bookings (que siguen vivos):
// aquí los totales los calcula la base de datos (vista ad_booking_stats +
// funciones de la migración 10), así que NO se truncan a 1.000 filas.
//
// Requiere: migración 10 aplicada.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const advertiserAuth = require('../../middleware/advertiserAuth');
const tenantAuth = require('../../middleware/tenantAuth');
const adminAuth = require('../../middleware/adminAuth');

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CHUNK = 100;
// Misma forma que las keys originales (24 bytes aleatorios en hex).
const newKey = () => crypto.randomBytes(24).toString('hex');

const wrap = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[ads/dashboard] ${label}`, err);
    res.status(500).json({ error: 'Error interno al procesar la solicitud' });
  }
};

const chunk = (arr, size = CHUNK) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Pagina una consulta (Supabase devuelve máx. 1.000 filas por request).
async function selectAll(makeQuery, pageSize = 1000, hardLimit = 20000) {
  const out = [];
  for (let from = 0; from < hardLimit; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

// Consulta con .in() partida en lotes (evita URLs gigantes).
async function selectIn(table, select, column, ids, extra) {
  const out = [];
  for (const part of chunk(ids)) {
    let q = supabaseAdmin.from(table).select(select).in(column, part);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
  }
  return out;
}

// Totales por reserva desde la vista (una fila por booking).
async function fetchStats(bookingIds) {
  const map = new Map();
  if (!bookingIds.length) return map;
  const rows = await selectIn('ad_booking_stats', '*', 'campaign_slot_id', bookingIds);
  rows.forEach((r) => map.set(r.campaign_slot_id, r));
  return map;
}

// Dinero de una reserva. Mismo criterio que el reporting original:
// CPM = impresiones/1000 × precio · fijo diario = días con impresiones × precio.
function money(booking, stat) {
  const impressions = Number(stat?.impressions || 0);
  const days = Number(stat?.active_days || 0);
  const price = Number(booking.agreed_price || 0);
  const gross = booking.pricing_model === 'cpm' ? (impressions / 1000) * price : days * price;
  const commission = gross * (Number(booking.commission_pct ?? 0) / 100);
  return {
    impressions,
    clicks: Number(stat?.clicks || 0),
    form_submits: Number(stat?.form_submits || 0),
    active_days: days,
    gross: r2(gross),
    commission: r2(commission),
    payout: r2(gross - commission)
  };
}

async function daySeries(bookingIds, days = 30) {
  if (!bookingIds.length) return [];
  const { data, error } = await supabaseAdmin.rpc('bitads_daily_series', { p_booking_ids: bookingIds, p_days: days });
  if (error) throw error;
  return (data || []).map((r) => ({ date: String(r.day).slice(0, 10), impressions: Number(r.impressions) }));
}

async function countLeads(creativeIds) {
  let total = 0;
  for (const part of chunk(creativeIds)) {
    const { count, error } = await supabaseAdmin
      .from('ad_form_responses').select('id', { count: 'exact', head: true }).in('creative_id', part);
    if (error) throw error;
    total += count || 0;
  }
  return total;
}

async function ownedCampaign(req, id, select = 'id') {
  if (!isUuid(id)) return null;
  const { data } = await supabaseAdmin
    .from('ad_campaigns').select(select).eq('id', id).eq('advertiser_id', req.advertiserId).maybeSingle();
  return data || null;
}

// Reservas (con campaña y venue) sobre los slots de un tenant, con sus totales.
async function tenantBookingsWithStats(tenantId) {
  const slots = await selectAll(() => supabaseAdmin
    .from('ad_slots')
    .select('id, slot_type, external_venue_name, country, status')
    .eq('bitads_tenant_id', tenantId).order('id'));
  const slotIds = slots.map((s) => s.id);
  const bookings = await selectIn(
    'ad_campaign_slots',
    'id, slot_id, campaign_id, agreed_price, pricing_model, status, commission_pct, payout_status, payout_at, created_at, ad_campaigns(name, ads_advertisers(name))',
    'slot_id', slotIds
  );
  const stats = await fetchStats(bookings.map((b) => b.id));
  return { slots, bookings, stats };
}

// campaign_id -> Set(nombres de venue) de reservas NO canceladas sobre slots del tenant.
function campaignVenueMap(slots, bookings) {
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const map = new Map();
  bookings.filter((b) => b.status !== 'cancelled').forEach((b) => {
    const venue = slotById.get(b.slot_id)?.external_venue_name || 'Venue';
    if (!map.has(b.campaign_id)) map.set(b.campaign_id, new Set());
    map.get(b.campaign_id).add(venue);
  });
  return map;
}

// ==================================================================
// ANUNCIANTE
// ==================================================================

// Identidad de la sesión (nombre de la cuenta) — también sirve para validar la API key al entrar
router.get('/advertiser/me', advertiserAuth, (req, res) => res.json({ name: req.advertiserName || null }));
router.get('/tenant/me', tenantAuth, (req, res) => res.json({ name: req.bitadsTenantName || null }));

// Resumen general
router.get('/advertiser/overview', advertiserAuth, wrap('advertiser/overview', async (req, res) => {
  const campaigns = await selectAll(() => supabaseAdmin
    .from('ad_campaigns').select('id, status').eq('advertiser_id', req.advertiserId).order('id'));
  const ids = campaigns.map((c) => c.id);
  const empty = { total_campaigns: 0, active_campaigns: 0, total_impressions: 0, total_spend: 0, total_leads: 0 };
  if (!ids.length) return res.json(empty);

  const bookings = await selectIn('ad_campaign_slots', 'id, campaign_id, agreed_price, pricing_model', 'campaign_id', ids);
  const stats = await fetchStats(bookings.map((b) => b.id));
  const creatives = await selectIn('ad_creatives', 'id', 'campaign_id', ids, (q) => q.eq('creative_type', 'form'));

  let impressions = 0, spend = 0;
  bookings.forEach((b) => {
    const m = money({ ...b, commission_pct: 0 }, stats.get(b.id));
    impressions += m.impressions;
    spend += m.gross;
  });

  res.json({
    total_campaigns: campaigns.length,
    active_campaigns: campaigns.filter((c) => c.status === 'active').length,
    total_impressions: impressions,
    total_spend: r2(spend),
    total_leads: await countLeads(creativeIdsOf(creatives))
  });
}));

function creativeIdsOf(rows) { return rows.map((r) => r.id); }

// Impresiones y gasto por campaña (una sola llamada para la lista)
router.get('/advertiser/campaign-stats', advertiserAuth, wrap('advertiser/campaign-stats', async (req, res) => {
  const campaigns = await selectAll(() => supabaseAdmin
    .from('ad_campaigns').select('id').eq('advertiser_id', req.advertiserId).order('id'));
  const ids = campaigns.map((c) => c.id);
  const out = {};
  ids.forEach((id) => { out[id] = { impressions: 0, spend: 0, bookings: 0, active_bookings: 0 }; });
  if (!ids.length) return res.json({ stats: out });

  const bookings = await selectIn('ad_campaign_slots', 'id, campaign_id, agreed_price, pricing_model, status', 'campaign_id', ids);
  const stats = await fetchStats(bookings.map((b) => b.id));
  bookings.forEach((b) => {
    const m = money({ ...b, commission_pct: 0 }, stats.get(b.id));
    const o = out[b.campaign_id];
    o.impressions += m.impressions;
    o.spend = r2(o.spend + m.gross);
    if (b.status !== 'cancelled') o.bookings += 1;
    if (b.status === 'scheduled' || b.status === 'running') o.active_bookings += 1;
  });
  res.json({ stats: out });
}));

// Reporte completo de una campaña (incluye reservas, serie diaria y calidad)
router.get('/campaigns/:id/report', advertiserAuth, wrap('campaigns/report', async (req, res) => {
  const campaign = await ownedCampaign(req, req.params.id,
    'id, name, status, start_date, end_date, budget_total, frequency_cap_per_day');
  if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

  const { data: bookings, error } = await supabaseAdmin
    .from('ad_campaign_slots')
    .select('id, slot_id, agreed_price, pricing_model, status, payment_status, created_at, ad_slots(external_venue_name, slot_type, country)')
    .eq('campaign_id', campaign.id)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const bookingIds = (bookings || []).map((b) => b.id);
  const stats = await fetchStats(bookingIds);

  let impressions = 0, clicks = 0, formSubmits = 0, spend = 0;
  const perSlot = (bookings || []).map((b) => {
    const m = money({ ...b, commission_pct: 0 }, stats.get(b.id));
    impressions += m.impressions; clicks += m.clicks; formSubmits += m.form_submits; spend += m.gross;
    return {
      booking_id: b.id,
      slot_id: b.slot_id,
      venue_name: b.ad_slots?.external_venue_name || null,
      slot_type: b.ad_slots?.slot_type || null,
      country: b.ad_slots?.country || null,
      status: b.status,
      payment_status: b.payment_status,
      pricing_model: b.pricing_model,
      agreed_price: Number(b.agreed_price),
      impressions: m.impressions,
      clicks: m.clicks,
      spend: m.gross,
      created_at: b.created_at
    };
  });

  const [daily, qualityRes, formCreatives] = await Promise.all([
    daySeries(bookingIds, 30),
    bookingIds.length
      ? supabaseAdmin.rpc('bitads_campaign_quality', { p_campaign_id: campaign.id })
      : Promise.resolve({ data: [], error: null }),
    selectIn('ad_creatives', 'id', 'campaign_id', [campaign.id], (q) => q.eq('creative_type', 'form'))
  ]);
  if (qualityRes.error) throw qualityRes.error;
  const q = (qualityRes.data || [])[0] || {};
  const rowsTotal = Number(q.rows_total || 0);
  const rowsWithDevice = Number(q.rows_with_device || 0);

  res.json({
    campaign,
    totals: {
      impressions,
      clicks,
      form_submits: formSubmits,
      spend: r2(spend),
      budget_total: campaign.budget_total !== null ? Number(campaign.budget_total) : null,
      budget_used_pct: campaign.budget_total ? Math.round((spend / Number(campaign.budget_total)) * 1000) / 10 : null,
      audio_completion_rate: q.audio_completion !== null && q.audio_completion !== undefined ? Math.round(Number(q.audio_completion) * 10) / 10 : null,
      unique_reach: rowsWithDevice > 0 ? Number(q.unique_devices) : null,
      reach_coverage_pct: rowsTotal > 0 ? Math.round((rowsWithDevice / rowsTotal) * 1000) / 10 : 0,
      leads: await countLeads(creativeIdsOf(formCreatives))
    },
    per_slot: perSlot,
    daily_series: daily
  });
}));

// Editar campaña (nombre, fechas, presupuesto de referencia, tope diario)
router.patch('/campaigns/:id', advertiserAuth, wrap('campaigns/patch', async (req, res) => {
  const campaign = await ownedCampaign(req, req.params.id, 'id, start_date, end_date');
  if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const updates = {};
  const b = req.body || {};

  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'El nombre es obligatorio (máx. 120 caracteres)' });
    updates.name = name;
  }
  if (b.start_date !== undefined) {
    if (!DATE_RE.test(b.start_date) || isNaN(Date.parse(b.start_date))) return res.status(400).json({ error: 'start_date inválida' });
    updates.start_date = b.start_date;
  }
  if (b.end_date !== undefined) {
    if (!DATE_RE.test(b.end_date) || isNaN(Date.parse(b.end_date))) return res.status(400).json({ error: 'end_date inválida' });
    updates.end_date = b.end_date;
  }
  const start = updates.start_date || campaign.start_date;
  const end = updates.end_date || campaign.end_date;
  if (new Date(end) < new Date(start)) return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la de inicio' });

  if (b.budget_total !== undefined) {
    if (b.budget_total === null || b.budget_total === '') updates.budget_total = null;
    else {
      const n = Number(b.budget_total);
      if (isNaN(n) || n < 0) return res.status(400).json({ error: 'El presupuesto debe ser un número mayor o igual a 0' });
      updates.budget_total = n;
    }
  }
  if (b.frequency_cap_per_day !== undefined) {
    const n = Number(b.frequency_cap_per_day);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'El tope diario debe ser un entero mayor o igual a 0' });
    updates.frequency_cap_per_day = n;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para actualizar' });
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('ad_campaigns').update(updates).eq('id', campaign.id).eq('advertiser_id', req.advertiserId).select().single();
  if (error) throw error;
  res.json({ campaign: data });
}));

// Eliminar un creativo (solo si todavía no tiene actividad registrada)
router.delete('/creatives/:id', advertiserAuth, wrap('creatives/delete', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Creativo no encontrado' });
  const { data: creative } = await supabaseAdmin
    .from('ad_creatives').select('id, ad_campaigns(advertiser_id)').eq('id', req.params.id).maybeSingle();
  if (!creative || creative.ad_campaigns?.advertiser_id !== req.advertiserId) {
    return res.status(404).json({ error: 'Creativo no encontrado' });
  }
  const [imp, resp] = await Promise.all([
    supabaseAdmin.from('ad_impressions').select('id', { count: 'exact', head: true }).eq('creative_id', creative.id),
    supabaseAdmin.from('ad_form_responses').select('id', { count: 'exact', head: true }).eq('creative_id', creative.id)
  ]);
  if ((imp.count || 0) > 0 || (resp.count || 0) > 0) {
    return res.status(409).json({ error: 'Este creativo ya tiene impresiones o respuestas registradas y no se puede eliminar. Pausa la campaña si quieres detenerlo.' });
  }
  const { error } = await supabaseAdmin.from('ad_creatives').delete().eq('id', creative.id);
  if (error) throw error;
  res.status(204).send();
}));

// Leads capturados por formularios de una campaña
router.get('/campaigns/:id/leads', advertiserAuth, wrap('campaigns/leads', async (req, res) => {
  const campaign = await ownedCampaign(req, req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

  const forms = await selectIn('ad_creatives', 'id', 'campaign_id', [campaign.id], (q) => q.eq('creative_type', 'form'));
  const formIds = creativeIdsOf(forms);
  if (!formIds.length) return res.json({ forms: [], leads: [] });

  const fields = await selectIn('ad_form_fields', 'creative_id, field_key, field_label, display_order', 'creative_id', formIds,
    (q) => q.order('display_order', { ascending: true }));
  const leads = [];
  for (const part of chunk(formIds)) {
    const rows = await selectAll(() => supabaseAdmin
      .from('ad_form_responses').select('id, creative_id, responses, submitted_at')
      .in('creative_id', part).order('submitted_at', { ascending: false }));
    leads.push(...rows);
  }
  res.json({
    forms: formIds.map((id) => ({
      creative_id: id,
      fields: fields.filter((f) => f.creative_id === id).map((f) => ({ field_key: f.field_key, field_label: f.field_label }))
    })),
    leads
  });
}));

// ==================================================================
// DUEÑO DE INVENTARIO (TENANT)
// ==================================================================

router.get('/tenant/overview', tenantAuth, wrap('tenant/overview', async (req, res) => {
  const { slots, bookings, stats } = await tenantBookingsWithStats(req.bitadsTenantId);
  let impressions = 0, earned = 0, pending = 0, paidOut = 0;
  bookings.forEach((b) => {
    const m = money(b, stats.get(b.id));
    impressions += m.impressions; earned += m.payout;
    if (b.payout_status === 'paid') paidOut += m.payout; else pending += m.payout;
  });

  // creativos pendientes de revisión (solo campañas con reservas no canceladas)
  const campaignIds = [...campaignVenueMap(slots, bookings).keys()];
  let pendingCreatives = 0;
  for (const part of chunk(campaignIds)) {
    const { count, error } = await supabaseAdmin
      .from('ad_creatives').select('id', { count: 'exact', head: true }).in('campaign_id', part).eq('review_status', 'pending');
    if (error) throw error;
    pendingCreatives += count || 0;
  }

  res.json({
    total_slots: slots.length,
    active_slots: slots.filter((s) => s.status === 'active').length,
    total_impressions: impressions,
    total_payout: r2(earned),
    pending_payout: r2(pending),
    paid_out: r2(paidOut),
    total_bookings: bookings.length,
    pending_creatives: pendingCreatives
  });
}));

router.get('/tenant/slot-stats', tenantAuth, wrap('tenant/slot-stats', async (req, res) => {
  const { slots, bookings, stats } = await tenantBookingsWithStats(req.bitadsTenantId);
  const out = {};
  slots.forEach((s) => { out[s.id] = { impressions: 0, payout: 0, bookings: 0 }; });
  bookings.forEach((b) => {
    const o = out[b.slot_id]; if (!o) return;
    const m = money(b, stats.get(b.id));
    o.impressions += m.impressions;
    o.payout = r2(o.payout + m.payout);
    if (b.status !== 'cancelled') o.bookings += 1;
  });
  res.json({ stats: out });
}));

router.get('/tenant/slots/:id/report', tenantAuth, wrap('tenant/slot-report', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Slot no encontrado' });
  const { data: slot } = await supabaseAdmin
    .from('ad_slots').select('id, slot_type, external_venue_name, country')
    .eq('id', req.params.id).eq('bitads_tenant_id', req.bitadsTenantId).maybeSingle();
  if (!slot) return res.status(404).json({ error: 'Slot no encontrado' });

  const { data: bookings, error } = await supabaseAdmin
    .from('ad_campaign_slots')
    .select('id, agreed_price, pricing_model, status, commission_pct, payout_status, ad_campaigns(name)')
    .eq('slot_id', slot.id);
  if (error) throw error;

  const ids = (bookings || []).map((b) => b.id);
  const stats = await fetchStats(ids);
  let impressions = 0, payout = 0;
  const perCampaign = (bookings || []).map((b) => {
    const m = money(b, stats.get(b.id));
    impressions += m.impressions; payout += m.payout;
    return {
      booking_id: b.id,
      campaign_name: b.ad_campaigns?.name || 'Campaña',
      status: b.status,
      payout_status: b.payout_status,
      impressions: m.impressions,
      estimated_payout: m.payout
    };
  });
  res.json({
    slot,
    totals: { impressions, estimated_payout: r2(payout) },
    per_campaign: perCampaign,
    daily_series: await daySeries(ids, 30)
  });
}));

router.get('/tenant/bookings', tenantAuth, wrap('tenant/bookings', async (req, res) => {
  const { slots, bookings, stats } = await tenantBookingsWithStats(req.bitadsTenantId);
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const rows = bookings.map((b) => {
    const m = money(b, stats.get(b.id));
    const slot = slotById.get(b.slot_id) || {};
    return {
      booking_id: b.id,
      campaign_name: b.ad_campaigns?.name || 'Campaña',
      advertiser_name: b.ad_campaigns?.ads_advertisers?.name || '—',
      venue_name: slot.external_venue_name || null,
      slot_type: slot.slot_type || null,
      status: b.status,
      impressions: m.impressions,
      estimated_payout: m.payout,
      payout_status: b.payout_status,
      payout_at: b.payout_at,
      created_at: b.created_at
    };
  }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ bookings: rows });
}));

router.get('/tenant/moderation', tenantAuth, wrap('tenant/moderation', async (req, res) => {
  const mode = req.query.status === 'history' ? 'history' : 'pending';
  const { slots, bookings } = await tenantBookingsWithStats(req.bitadsTenantId);
  const venueMap = campaignVenueMap(slots, bookings);
  const campaignIds = [...venueMap.keys()];
  if (!campaignIds.length) return res.json({ creatives: [] });

  const select = '*, ad_campaigns(id, name, ads_advertisers(name)), ad_form_fields(field_key, field_label, field_type, options, required, display_order)';
  const rows = await selectIn('ad_creatives', select, 'campaign_id', campaignIds, (q) =>
    mode === 'pending'
      ? q.eq('review_status', 'pending').order('created_at', { ascending: true })
      : q.in('review_status', ['approved', 'rejected']).order('created_at', { ascending: false }).limit(100));

  const creatives = rows.map((c) => ({
    id: c.id,
    campaign_id: c.campaign_id,
    campaign_name: c.ad_campaigns?.name || 'Campaña',
    advertiser_name: c.ad_campaigns?.ads_advertisers?.name || '—',
    creative_type: c.creative_type,
    file_url: c.file_url,
    duration_sec: c.duration_sec,
    destination_url: c.destination_url,
    applicable_slot_types: c.applicable_slot_types,
    review_status: c.review_status,
    rejection_reason: c.rejection_reason,
    created_at: c.created_at,
    venues: [...(venueMap.get(c.campaign_id) || [])],
    form_fields: (c.ad_form_fields || []).sort((a, b) => a.display_order - b.display_order)
  }));
  creatives.sort((a, b) => mode === 'pending'
    ? String(a.created_at).localeCompare(String(b.created_at))
    : String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ creatives: creatives.slice(0, 100) });
}));


// ==================================================================
// ROTACIÓN DE API KEYS
// La key anterior deja de funcionar al instante. La nueva se devuelve una sola vez.
// ==================================================================
async function rotate(table, idCol, id, keyCol, extraMatch) {
  const key = newKey();
  let q = supabaseAdmin.from(table).update({ [keyCol]: key, updated_at: new Date().toISOString() }).eq(idCol, id);
  if (extraMatch) q = q.eq(extraMatch[0], extraMatch[1]);
  const { data, error } = await q.select('id').maybeSingle();
  if (error) throw error;
  return data ? key : null;
}
router.post('/tenant/rotate-key', tenantAuth, wrap('tenant/rotate-key', async (req, res) => {
  const key = await rotate('bitads_tenants', 'id', req.bitadsTenantId, 'api_key');
  if (!key) return res.status(404).json({ error: 'Cuenta no encontrada' });
  res.json({ api_key: key });
}));
router.post('/advertiser/rotate-key', advertiserAuth, wrap('advertiser/rotate-key', async (req, res) => {
  const key = await rotate('ads_advertisers', 'id', req.advertiserId, 'api_key');
  if (!key) return res.status(404).json({ error: 'Cuenta no encontrada' });
  res.json({ api_key: key });
}));
// Cambia la key de UN slot. La pantalla/portal conectado deja de recibir anuncios hasta que se actualice.
router.post('/tenant/slots/:id/rotate-key', tenantAuth, wrap('tenant/slots/rotate-key', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Slot no encontrado' });
  const key = await rotate('ad_slots', 'id', req.params.id, 'slot_api_key', ['bitads_tenant_id', req.bitadsTenantId]);
  if (!key) return res.status(404).json({ error: 'Slot no encontrado' });
  res.json({ slot_api_key: key });
}));

// ==================================================================
// ADMIN
// ==================================================================

async function adminBookings() {
  const bookings = await selectAll(() => supabaseAdmin
    .from('ad_campaign_slots')
    .select(`
      id, campaign_id, agreed_price, pricing_model, status, commission_pct,
      payment_status, payout_status, payout_at, payout_notes, created_at,
      ad_campaigns(name, ads_advertisers(name, contact_email)),
      ad_slots(external_venue_name, slot_type, bitads_tenants(name, contact_email))
    `)
    .order('created_at', { ascending: false }));
  const stats = await fetchStats(bookings.map((b) => b.id));
  return bookings.map((b) => {
    const m = money(b, stats.get(b.id));
    return {
      id: b.id,
      campaign_name: b.ad_campaigns?.name || null,
      advertiser_name: b.ad_campaigns?.ads_advertisers?.name || null,
      advertiser_email: b.ad_campaigns?.ads_advertisers?.contact_email || null,
      venue_name: b.ad_slots?.external_venue_name || null,
      slot_type: b.ad_slots?.slot_type || null,
      tenant_name: b.ad_slots?.bitads_tenants?.name || null,
      tenant_email: b.ad_slots?.bitads_tenants?.contact_email || null,
      booking_status: b.status,
      pricing_model: b.pricing_model,
      agreed_price: Number(b.agreed_price),
      impressions: m.impressions,
      gross_revenue: m.gross,
      commission_pct: Number(b.commission_pct),
      commission_amount: m.commission,
      venue_payout: m.payout,
      payment_status: b.payment_status,
      payout_status: b.payout_status,
      payout_at: b.payout_at,
      payout_notes: b.payout_notes,
      created_at: b.created_at
    };
  });
}

router.get('/admin/bookings', adminAuth, wrap('admin/bookings', async (req, res) => {
  res.json({ bookings: await adminBookings() });
}));

router.get('/admin/overview', adminAuth, wrap('admin/overview', async (req, res) => {
  const count = async (table, apply) => {
    let q = supabaseAdmin.from(table).select('id', { count: 'exact', head: true });
    if (apply) q = apply(q);
    const { count: c, error } = await q;
    if (error) throw error;
    return c || 0;
  };
  const [tenants, tenantsVerified, advertisers, advertisersVerified, activeCampaigns, activeSlots, newLeads, bookings] =
    await Promise.all([
      count('bitads_tenants'),
      count('bitads_tenants', (q) => q.eq('email_verified', true)),
      count('ads_advertisers'),
      count('ads_advertisers', (q) => q.eq('email_verified', true)),
      count('ad_campaigns', (q) => q.eq('status', 'active')),
      count('ad_slots', (q) => q.eq('status', 'active')),
      count('bitads_leads', (q) => q.eq('status', 'new')),
      adminBookings()
    ]);

  const sum = (rows, key) => r2(rows.reduce((a, r) => a + r[key], 0));
  const toCollect = bookings.filter((b) => b.payment_status !== 'paid');
  const collected = bookings.filter((b) => b.payment_status === 'paid');
  const toPay = bookings.filter((b) => b.payout_status !== 'paid');
  const paid = bookings.filter((b) => b.payout_status === 'paid');

  res.json({
    accounts: { tenants, tenants_verified: tenantsVerified, advertisers, advertisers_verified: advertisersVerified },
    active_campaigns: activeCampaigns,
    active_slots: activeSlots,
    new_leads: newLeads,
    money: {
      gross_total: sum(bookings, 'gross_revenue'),
      commission_total: sum(bookings, 'commission_amount'),
      to_collect: sum(toCollect, 'gross_revenue'),
      collected: sum(collected, 'gross_revenue'),
      payout_pending: sum(toPay, 'venue_payout'),
      payout_paid: sum(paid, 'venue_payout'),
      bookings_to_collect: toCollect.filter((b) => b.gross_revenue > 0).length,
      bookings_to_pay: toPay.filter((b) => b.venue_payout > 0).length
    }
  });
}));

router.get('/admin/leads', adminAuth, wrap('admin/leads', async (req, res) => {
  const status = ['new', 'contacted', 'converted', 'discarded'].includes(req.query.status) ? req.query.status : null;
  const leads = await selectAll(() => {
    let q = supabaseAdmin.from('bitads_leads').select('*').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    return q;
  });
  res.json({ leads });
}));

router.patch('/admin/leads/:id', adminAuth, wrap('admin/leads/patch', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Lead no encontrado' });
  const { status } = req.body || {};
  if (!['new', 'contacted', 'converted', 'discarded'].includes(status)) {
    return res.status(400).json({ error: 'status inválido' });
  }
  const { data, error } = await supabaseAdmin.from('bitads_leads').update({ status }).eq('id', req.params.id).select().maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Lead no encontrado' });
  res.json({ lead: data });
}));

// Cuentas (NUNCA se devuelve api_key)
router.get('/admin/accounts', adminAuth, wrap('admin/accounts', async (req, res) => {
  const [venues, advertisers] = await Promise.all([
    selectAll(() => supabaseAdmin.from('bitads_tenants')
      .select('id, name, contact_email, status, email_verified, created_at').order('created_at', { ascending: false })),
    selectAll(() => supabaseAdmin.from('ads_advertisers')
      .select('id, name, contact_email, industry, status, email_verified, created_at').order('created_at', { ascending: false }))
  ]);
  res.json({ venues, advertisers });
}));

router.patch('/admin/accounts/:type/:id', adminAuth, wrap('admin/accounts/patch', async (req, res) => {
  const table = { venue: 'bitads_tenants', advertiser: 'ads_advertisers' }[req.params.type];
  if (!table || !isUuid(req.params.id)) return res.status(404).json({ error: 'Cuenta no encontrada' });
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: "status debe ser 'active' o 'suspended'" });
  const { data, error } = await supabaseAdmin
    .from(table).update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id)
    .select('id, name, status').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Cuenta no encontrada' });
  res.json({ account: data });
}));

module.exports = router;
module.exports._test = { money, r2, chunk, isUuid };
