// NEO-SUSU service worker
// - Pages HTML : reseau d'abord (toujours a jour), cache en secours hors ligne
// - CSS / JS / images / polices : cache d'abord, mis a jour en arriere-plan
// - API Supabase et autres requetes : jamais mises en cache
const CACHE = "neo-susu-v4";
const PRECACHE = [
  "./", "./index.html", "./login.html", "./signup.html", "./dashboard.html",
  "./create-tontine.html", "./join-tontine.html", "./tontine-detail.html",
  "./profile.html", "./neo-susu.css", "./plans.js", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png"
];
const STATIC_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(PRECACHE.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (req.mode === "navigate" && sameOrigin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html")))
    );
    return;
  }

  if ((sameOrigin && url.pathname !== new URL("./supabase.js", self.location).pathname) || STATIC_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(req).then(cached => {
          const network = fetch(req)
            .then(res => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
  }
});
