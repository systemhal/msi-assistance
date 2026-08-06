/**
 * =============================================================================
 * AsistenciaMSI — Service Worker v1.0.0
 * =============================================================================
 * SEGURIDAD:
 *  - Solo cachea archivos de la LISTA BLANCA (ningún recurso externo no autorizado).
 *  - Estrategia Network-First: siempre intenta el servidor; caché solo si sin red.
 *  - Versión de caché con hash: al cambiar la versión, el caché viejo se elimina.
 *  - Solo intercepta peticiones del MISMO ORIGEN (same-origin).
 *  - Nunca cachea respuestas opacas (de otros dominios sin CORS).
 *  - Nunca cachea respuestas con código de error HTTP.
 *  - Nunca cachea peticiones POST (datos sensibles de asistencia).
 * =============================================================================
 */

'use strict';

// ── Versión del caché ─────────────────────────────────────────────────────────
// Cambia este valor cada vez que actualices los archivos del proyecto.
// Esto fuerza la eliminación del caché antiguo en todos los dispositivos.
const CACHE_VERSION  = 'asistencia-msi-v1.0.5';
const CACHE_NAME     = `${CACHE_VERSION}`;

// ── Lista Blanca de archivos a cachear ───────────────────────────────────────
// SOLO estos archivos se almacenarán en el caché del dispositivo.
// Cualquier otro recurso se solicita siempre desde el servidor.
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icono.png',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];



// ── Dominios externos permitidos para FETCH (sin cachear) ────────────────────
// Solo se permite pasar peticiones a estos dominios de confianza.
const ALLOWED_EXTERNAL_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdn.jsdelivr.net',
  'https://script.google.com',
  'https://script.googleusercontent.com'
];


// =============================================================================
// EVENTO: INSTALL — Pre-cacheo de la lista blanca
// =============================================================================
self.addEventListener('install', (event) => {
  console.log(`[SW] Instalando caché: ${CACHE_NAME}`);

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Pre-cacheando archivos de la lista blanca...');
        // addAll falla si CUALQUIER archivo no responde correctamente.
        // Esto garantiza que el caché siempre tiene todos los archivos o ninguno.
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => {
        console.log('[SW] Pre-cacheo completado.');
        // Forzar que el nuevo SW tome control inmediatamente sin esperar reload.
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[SW] Error durante pre-cacheo:', err);
      })
  );
});

// =============================================================================
// EVENTO: ACTIVATE — Limpieza de cachés viejos
// =============================================================================
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activando: ${CACHE_NAME}`);

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME) // Identificar cachés obsoletos
          .map((oldCache) => {
            console.log(`[SW] Eliminando caché obsoleto: ${oldCache}`);
            return caches.delete(oldCache); // Borrar caché viejo
          })
      );
    }).then(() => {
      console.log('[SW] Listo. Tomando control de todos los clientes.');
      return self.clients.claim(); // Tomar control sin recargar
    })
  );
});

// =============================================================================
// EVENTO: FETCH — Interceptor de peticiones (núcleo de seguridad)
// =============================================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);

  // ── REGLA 1: Solo GET. Nunca interceptar POST/PUT/DELETE ─────────────────
  // Las marcaciones de asistencia son peticiones POST → van siempre al servidor.
  if (request.method !== 'GET') {
    return; // Sin event.respondWith → pasa directo al servidor
  }

  // ── REGLA 2: Verificar origen ─────────────────────────────────────────────
  const isSameOrigin = requestUrl.origin === self.location.origin;
  const isAllowedExternal = ALLOWED_EXTERNAL_ORIGINS.some(
    (origin) => requestUrl.href.startsWith(origin)
  );

  // Bloquear peticiones a orígenes no autorizados
  if (!isSameOrigin && !isAllowedExternal) {
    console.warn(`[SW][BLOQUEADO] Origen no autorizado: ${requestUrl.origin}`);
    event.respondWith(
      new Response('Acceso bloqueado por política de seguridad.', {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'text/plain' }
      })
    );
    return;
  }

  // ── REGLA 3: Recursos externos permitidos → Solo Red, NUNCA caché ─────────
  // Fuentes, CDN, Google Apps Script → siempre desde el servidor.
  if (!isSameOrigin) {
    event.respondWith(fetch(request).catch(() => {
      // Si hay error de red en recurso externo, respuesta vacía controlada
      return new Response('', { status: 503, statusText: 'Service Unavailable' });
    }));
    return;
  }

  // ── REGLA 4: Recursos propios → Estrategia Network-First ─────────────────
  // Siempre intenta obtener la versión más reciente del servidor.
  // Solo usa caché si no hay conexión a internet (modo offline).
  event.respondWith(networkFirst(request));
});

// =============================================================================
// FUNCIÓN: Network-First con fallback al caché
// =============================================================================
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    // 1. Intentar obtener desde el servidor (red)
    const networkResponse = await fetch(request);

    // ── Validaciones de seguridad antes de cachear ─────────────────────────
    // No cachear respuestas con errores HTTP
    if (!networkResponse || !networkResponse.ok) {
      console.warn(`[SW] Respuesta con error, no se cachea: ${request.url} (${networkResponse?.status})`);
      return networkResponse;
    }

    // No cachear respuestas opacas (de orígenes sin CORS, no confiables)
    if (networkResponse.type === 'opaque') {
      console.warn(`[SW] Respuesta opaca rechazada para caché: ${request.url}`);
      return networkResponse;
    }

    // Solo cachear si está en la lista blanca
    const requestPath = new URL(request.url).pathname;
    const isWhitelisted = PRECACHE_ASSETS.some(
      (asset) => asset === requestPath || requestPath.endsWith(asset.split('/').pop())
    );

    if (isWhitelisted) {
      // Guardar copia en caché para uso offline
      cache.put(request, networkResponse.clone());
      console.log(`[SW] Actualizado en caché: ${request.url}`);
    }

    return networkResponse;

  } catch (networkError) {
    // 2. Sin conexión → intentar servir desde caché
    console.warn(`[SW] Sin red, buscando en caché: ${request.url}`);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
      console.log(`[SW] Sirviendo desde caché offline: ${request.url}`);
      return cachedResponse;
    }

    // 3. Sin red y sin caché → respuesta de error amigable
    console.error(`[SW] Recurso no disponible offline: ${request.url}`);
    return new Response(
      `<!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Sin conexión - AsistenciaMSI</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0f0f1a; color: #fff;
               display: flex; align-items: center; justify-content: center;
               min-height: 100vh; margin: 0; text-align: center; padding: 20px; }
        .card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                border-radius: 16px; padding: 40px; max-width: 360px; }
        .icon { font-size: 48px; margin-bottom: 16px; }
        h2 { color: #ef4444; margin: 0 0 12px; }
        p  { color: #aaa; line-height: 1.6; }
        button { margin-top: 20px; padding: 12px 24px; background: #ef4444;
                 color: #fff; border: none; border-radius: 8px; cursor: pointer;
                 font-size: 15px; font-weight: 600; }
      </style></head>
      <body>
        <div class="card">
          <div class="icon">📡</div>
          <h2>Sin conexión</h2>
          <p>No hay conexión a Internet en este momento.<br>
             Conéctate a la red y vuelve a intentarlo.</p>
          <button onclick="location.reload()">🔄 Reintentar</button>
        </div>
      </body></html>`,
      {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }
    );
  }
}

// =============================================================================
// EVENTO: MESSAGE — Canal de comunicación con la app principal
// =============================================================================
self.addEventListener('message', (event) => {
  if (!event.data) return;

  // Comando para forzar actualización inmediata
  if (event.data.action === 'SKIP_WAITING') {
    console.log('[SW] Forzando actualización por comando de la app...');
    self.skipWaiting();
  }

  // Comando para limpiar caché manualmente
  if (event.data.action === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      console.log('[SW] Caché limpiado manualmente.');
    });
  }
});
