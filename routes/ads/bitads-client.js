// bitads-client.js
//
// Módulo reutilizable para integrar CUALQUIER player de Bit Proximity
// (BitSignage, BitMusic, portal WiFi) con el motor de rotación de BitAds.
// No tiene dependencias — funciona en navegador o en un player embebido
// (Electron, WebView, etc.).
//
// USO BÁSICO:
//
//   import { fetchNextAd, reportImpression } from './bitads-client.js';
//
//   const ad = await fetchNextAd('SLOT_API_KEY_DEL_SCREEN');
//   if (ad) {
//     // mostrar ad.file_url por ad.duration_sec segundos, luego volver
//     // a la playlist normal
//     await reportImpression(ad.campaign_slot_id, ad.id, { estimated_count: 1 });
//   } else {
//     // no hay anuncio elegible -> seguir con el contenido normal
//   }

const BITADS_API_BASE = "https://api.bitadsapp.com/api/ads";

/**
 * Pide el próximo creativo a mostrar/reproducir en un slot.
 * @param {string} slotApiKey - el slot_api_key generado al crear el slot en BitAds
 * @returns {Promise<null | {id, type, file_url, duration_sec, dimensions, campaign_slot_id}>}
 *          null si no hay ningún anuncio elegible ahora mismo (204) —
 *          en ese caso el player debe seguir con su contenido normal.
 */
export async function fetchNextAd(slotApiKey) {
  if (!slotApiKey) {
    console.warn('[BitAds] slotApiKey vacío, se omite la llamada');
    return null;
  }
  try {
    const res = await fetch(`${BITADS_API_BASE}/rotation/${slotApiKey}`, {
      method: 'GET'
    });

    if (res.status === 204) return null; // sin anuncios elegibles ahora
    if (!res.ok) {
      console.warn(`[BitAds] rotation devolvió ${res.status}`);
      return null; // ante cualquier error, el player sigue con su contenido normal
    }

    const data = await res.json();
    return { ...data.creative, campaign_slot_id: data.campaign_slot_id };
  } catch (err) {
    // Si BitAds está caído o hay un problema de red, NUNCA debe bloquear
    // el player de Bit Proximity — se degrada a "sin anuncio" y sigue andando.
    console.warn('[BitAds] error de red en fetchNextAd', err);
    return null;
  }
}

/**
 * Reporta el conteo real de impresiones/reproducciones (opcional pero
 * recomendado: mejora la precisión del reporting para el anunciante).
 * @param {string} campaignSlotId - viene en la respuesta de fetchNextAd
 * @param {string} creativeId - viene en la respuesta de fetchNextAd (campo "id")
 * @param {object} [opts]
 * @param {number} [opts.estimated_count] - ej: tráfico estimado frente a pantalla,
 *        conexiones wifi, plays completos de audio. Default 1.
 * @param {string} [opts.device_id] - identificador de DISPOSITIVO (no de persona),
 *        ej. un hash de la MAC address en el portal wifi. Opcional. Si se manda,
 *        BitAds puede calcular "reach" (alcance único) en vez de solo impresiones
 *        totales. Sin este dato, el reporte de reach queda vacío — no se inventa.
 * @param {number} [opts.play_duration_sec] - SOLO para audio: cuántos segundos
 *        se reprodujeron realmente del anuncio. Con esto, BitAds calcula el
 *        completion rate (% del anuncio que efectivamente se escuchó). Sin este
 *        dato, el completion rate queda vacío.
 * @param {object} [opts.metadata] - datos extra opcionales (ej: {clicked: true})
 */
export async function reportImpression(campaignSlotId, creativeId, opts = {}) {
  const metadata = { ...(opts.metadata || {}) };
  if (opts.device_id) metadata.device_id = opts.device_id;
  if (typeof opts.play_duration_sec === 'number') metadata.play_duration_sec = opts.play_duration_sec;

  try {
    await fetch(`${BITADS_API_BASE}/rotation/impression`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign_slot_id: campaignSlotId,
        creative_id: creativeId,
        estimated_count: opts.estimated_count ?? 1,
        metadata
      })
    });
  } catch (err) {
    // No crítico: si falla el reporte, no interrumpir al player.
    console.warn('[BitAds] error al reportar impresión', err);
  }
}
