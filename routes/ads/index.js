<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BitAds Screen Widget</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background: #0B0E11;
    overflow: hidden;
  }
  #stage {
    width: 100vw; height: 100vh;
    display: flex; align-items: center; justify-content: center;
    position: relative;
  }
  #stage img, #stage video {
    max-width: 100%; max-height: 100%;
    width: 100%; height: 100%;
    object-fit: cover;
  }
  /* Estado sin anuncio disponible: pantalla neutra, discreta.
     Si tienes un logo/branding de fallback, reemplaza este bloque. */
  #empty-state {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    color: #22272E;
    font-family: sans-serif;
    font-size: 14px;
  }
</style>
</head>
<body>
<div id="stage">
  <div id="empty-state">BitAds</div>
</div>

<script>
// ============================================================
// BitAds — Screen Widget para AiScreen (u otra plataforma de
// signage que soporte insertar una URL/HTML dentro del playlist).
//
// USO EN AISCREEN:
// Agrega este item al playlist como "Live URL" / "Web Content":
//   https://ads.bitadsapp.com/screen/?slot=TU_SLOT_API_KEY
// y asignale una duración fija en el playlist (ej. 15 segundos).
// Esta página internamente refresca el anuncio en loop, así que
// aunque AiScreen la mantenga cargada de forma persistente en vez
// de recargarla en cada ciclo, igual va rotando anuncios distintos.
// ============================================================

// TODO: si cambia el dominio de la API, actualizar acá.
const BITADS_API_BASE = "https://api.bitadsapp.com/api/ads";

const DEFAULT_IMAGE_DURATION_MS = 10000; // cuánto se muestra una imagen si el creativo no trae duration_sec
const RETRY_WHEN_EMPTY_MS = 15000;       // cada cuánto reintenta si no hay anuncio elegible

function getSlotKey() {
  const params = new URLSearchParams(window.location.search);
  return params.get('slot');
}

async function fetchNextAd(slotApiKey) {
  try {
    const res = await fetch(`${BITADS_API_BASE}/rotation/${slotApiKey}`);
    if (res.status === 204) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return { ...data.creative, campaign_slot_id: data.campaign_slot_id };
  } catch (err) {
    console.warn('[BitAds Screen Widget] error de red', err);
    return null;
  }
}

async function reportImpression(campaignSlotId, creativeId) {
  try {
    await fetch(`${BITADS_API_BASE}/rotation/impression`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_slot_id: campaignSlotId, creative_id: creativeId, estimated_count: 1 })
    });
  } catch (err) {
    console.warn('[BitAds Screen Widget] error al reportar impresión', err);
  }
}

function showEmpty() {
  document.getElementById('stage').innerHTML = '<div id="empty-state">BitAds</div>';
}

function showImage(url, destinationUrl) {
  const stage = document.getElementById('stage');
  stage.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  if (destinationUrl) {
    const link = document.createElement('a');
    link.href = destinationUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.display = 'block';
    link.style.width = '100%';
    link.style.height = '100%';
    link.onclick = () => reportClick(window.__currentCampaignSlotId, window.__currentCreativeId);
    link.appendChild(img);
    stage.appendChild(link);
  } else {
    stage.appendChild(img);
  }
}

function showVideo(url, destinationUrl) {
  const stage = document.getElementById('stage');
  stage.innerHTML = '';
  const video = document.createElement('video');
  video.src = url;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  if (destinationUrl) {
    const link = document.createElement('a');
    link.href = destinationUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.style.display = 'block';
    link.style.width = '100%';
    link.style.height = '100%';
    link.onclick = () => reportClick(window.__currentCampaignSlotId, window.__currentCreativeId);
    link.appendChild(video);
    stage.appendChild(link);
  } else {
    stage.appendChild(video);
  }
}

async function reportClick(campaignSlotId, creativeId) {
  if (!campaignSlotId || !creativeId) return;
  try {
    await fetch(`${BITADS_API_BASE}/rotation/impression`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_slot_id: campaignSlotId, creative_id: creativeId, estimated_count: 0, metadata: { clicked: true } })
    });
  } catch (err) { /* silencioso, no bloquear la navegación del usuario */ }
}

async function cycle() {
  const slotKey = getSlotKey();
  if (!slotKey) {
    document.getElementById('empty-state').textContent = 'Falta el parámetro ?slot= en la URL';
    return;
  }

  const ad = await fetchNextAd(slotKey);

  if (!ad) {
    showEmpty();
    setTimeout(cycle, RETRY_WHEN_EMPTY_MS);
    return;
  }

  window.__currentCampaignSlotId = ad.campaign_slot_id;
  window.__currentCreativeId = ad.id;

  if (ad.type === 'form') {
    // los formularios son para canales interactivos (wifi/web), no para
    // pantallas pasivas — se registra la impresión pero no se muestra nada,
    // y se reintenta pronto por si hay otro anuncio elegible.
    console.warn('[BitAds Screen Widget] Se recibió un creativo tipo form, no soportado en pantalla. Saltando.');
    showEmpty();
    setTimeout(cycle, RETRY_WHEN_EMPTY_MS);
    return;
  }

  if (ad.type === 'video') {
    showVideo(ad.file_url, ad.destination_url);
  } else {
    // 'image' y 'html5' se muestran como imagen fullscreen por simplicidad;
    // 'html5' con interactividad real necesitaría un <iframe> — no soportado
    // en esta primera versión del widget.
    showImage(ad.file_url, ad.destination_url);
  }

  reportImpression(ad.campaign_slot_id, ad.id);

  const durationMs = (ad.duration_sec ? ad.duration_sec * 1000 : DEFAULT_IMAGE_DURATION_MS);
  setTimeout(cycle, durationMs);
}

cycle();
</script>
</body>
</html>
