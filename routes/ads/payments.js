// routes/ads/payments.js
// Tracking de pago MANUAL — vos (o el tenant dueño del slot) marca
// una reserva como pagada después de recibir el pago por fuera del
// sistema (transferencia, efectivo, lo que sea). No mueve dinero,
// solo lleva registro de qué se cobró.

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const tenantAuth = require('../../middleware/tenantAuth');

router.use(tenantAuth);

// PATCH /api/ads/payments/:bookingId — marcar pagado/pendiente/exonerado
router.patch('/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const { payment_status, payment_notes } = req.body;

  const validStatuses = ['pending', 'paid', 'waived'];
  if (!validStatuses.includes(payment_status)) {
    return res.status(400).json({ error: `payment_status inválido. Usar: ${validStatuses.join(', ')}` });
  }

  try {
    // verificar que esta reserva corresponde a un slot de este tenant
    const { data: booking, error: fetchErr } = await supabaseAdmin
      .from('ad_campaign_slots')
      .select('id, slot_id, ad_slots(bitads_tenant_id)')
      .eq('id', bookingId)
      .single();

    if (fetchErr || !booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (booking.ad_slots?.bitads_tenant_id !== req.bitadsTenantId) {
      return res.status(403).json({ error: 'Esta reserva no corresponde a tu inventario' });
    }

    const updates = {
      payment_status,
      payment_notes: payment_notes || null,
      paid_at: payment_status === 'paid' ? new Date().toISOString() : null
    };

    const { data, error } = await supabaseAdmin
      .from('ad_campaign_slots')
      .update(updates)
      .eq('id', bookingId)
      .select()
      .single();

    if (error) throw error;
    res.json({ booking: data });
  } catch (err) {
    console.error('[ads/payments] PATCH /:bookingId', err);
    res.status(500).json({ error: 'No se pudo actualizar el estado de pago' });
  }
});

module.exports = router;
