// Service worker de Trivia UTS
// - App shell (archivos propios): stale-while-revalidate. Carga al instante desde
//   la caché y en segundo plano descarga la versión nueva para la siguiente visita.
// - API (solo lecturas GET): network-first. Si no hay red se responde con la
//   última copia guardada, así las pantallas de progreso, selección de materia,
//   el juego y los listados del admin siguen funcionando sin conexión.
const SHELL_CACHE = 'trivia-shell-v1'
const API_CACHE = 'trivia-api-v1'
const API_ORIGIN = 'https://userapi-m8ef.onrender.com'

const staticAssets = [
    './',
    './index.html',
    './app.css',
    './app.js',
    './manifest.webmanifest',
    './icon-192.png',
    './icon-512.png'
]

// Lecturas de la API que se guardan para usarse sin conexión.
// GetSession no entra: siempre debe validarse contra el servidor.
const cacheableApi = [
    '/api/Auth/Get/',
    '/api/Subject/Get/',
    '/api/Question/Get/',
    '/api/Score/Get/'
]

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(staticAssets))
            .then(() => self.skipWaiting())
    )
})

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(key => key.startsWith('trivia-') && key !== SHELL_CACHE && key !== API_CACHE)
                .map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    )
})

self.addEventListener('fetch', e => {
    const req = e.request
    // POST/PUT (crear, editar, eliminar, guardar score) siempre van directo a la red
    if (req.method !== 'GET') return

    const url = new URL(req.url)
    if (url.origin == location.origin) {
        e.respondWith(staleWhileRevalidate(req))
        return
    }
    if (url.origin == API_ORIGIN && cacheableApi.some(path => url.pathname.startsWith(path))) {
        e.respondWith(networkFirst(req))
    }
})

async function staleWhileRevalidate(req) {
    const cache = await caches.open(SHELL_CACHE)
    // Es una SPA: cualquier navegación se resuelve con index.html
    const key = req.mode === 'navigate' ? './index.html' : req
    const cached = await cache.match(key, { ignoreSearch: true })

    const update = fetch(req)
        .then(res => {
            if (res.ok && !res.redirected) cache.put(key, res.clone())
            return res
        })
        .catch(() => null)

    if (cached) return cached
    return (await update) || new Response('Sin conexión', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
}

async function networkFirst(req) {
    const cache = await caches.open(API_CACHE)
    try {
        const fresh = await fetch(req)
        if (fresh.ok) await cache.put(req, await withHeaders(fresh.clone(), { 'X-SW-Cached-At': String(Date.now()) }))
        return fresh
    }
    catch (e) {
        const cached = await cache.match(req)
        if (cached) return withHeaders(cached, { 'X-SW-Cache': 'fallback' })

        // Mismo formato que los errores de la API para que app.js lo muestre igual
        return new Response(JSON.stringify({
            message: 'Sin conexión y todavía no hay datos guardados de esta sección',
            code: 'OFFLINE'
        }), {
            status: 503,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'X-SW-Cache': 'miss',
                'Access-Control-Expose-Headers': 'X-SW-Cache'
            }
        })
    }
}

// Copia la respuesta con cabeceras extra. Las X-SW-* se exponen para que la
// página pueda leerlas aunque la petición sea cross-origin.
async function withHeaders(res, extra) {
    const headers = new Headers(res.headers)
    Object.entries(extra).forEach(([key, value]) => headers.set(key, value))
    headers.set('Access-Control-Expose-Headers', 'X-SW-Cache, X-SW-Cached-At')
    return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers })
}
