/**
 * StoreControl - PWA Service Worker (v2.1.0)
 * App-Name: Store Control
 * Caches application shell for offline capability and instant loading on smartphones & PC.
 */

const CACHE_NAME = 'storecontrol-pwa-v2.1.0';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/sync-manager.js',
    '/data-service.js',
    '/manifest.json',
    '/manifest.webmanifest',
    '/icons/icon.svg',
    '/icons/icon-192.png',
    '/icons/icon-192-maskable.png',
    '/icons/icon-512.png',
    '/icons/icon-512-maskable.png',
    '/icons/apple-touch-icon.png'
];

// Install Event: Pre-cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Pre-caching static assets for offline use');
            return cache.addAll(STATIC_ASSETS);
        }).then(() => self.skipWaiting())
    );
});

// Activate Event: Clean old caches and claim clients immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('[SW] Removing old cache:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Event: Network-first for API, Stale-while-revalidate for static assets, Robust Navigation
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests and SSE stream
    if (event.request.method !== 'GET' || url.pathname.startsWith('/api/events')) {
        return;
    }

    // API calls: Network-first (always get latest central data when online)
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                // If offline, return a JSON error so client uses local offline cache
                return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
        return;
    }

    // HTML Navigation requests (e.g. / or /?source=pwa): Network-first with cache fallback
    if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(
            fetch(event.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
                }
                return networkResponse;
            }).catch(async () => {
                const cached = await caches.match('/', { ignoreSearch: true }) || await caches.match('/index.html');
                if (cached) return cached;
                return new Response('Store Control ist offline. Bitte prüfen Sie Ihre Verbindung.', {
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=UTF-8' }
                });
            })
        );
        return;
    }

    // Static assets: Stale-while-revalidate with ignoreSearch for query parameters
    event.respondWith(
        caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return networkResponse;
            }).catch(() => null);

            return cachedResponse || fetchPromise;
        })
    );
});
