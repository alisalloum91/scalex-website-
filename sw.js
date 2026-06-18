const CACHE = 'scalex-v2';
const ASSETS = [
  '/',
  '/about',
  '/services',
  '/digital-marketing',
  '/social-media',
  '/content',
  '/performance',
  '/web-dev',
  '/seo',
  '/crm',
  '/automation',
  '/whatsapp',
  '/chatbots',
  '/outdoor',
  '/industries',
  '/contact',
  '/style.css',
  '/images/HOME-HERO-IMG.webp',
  '/images/logo.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
