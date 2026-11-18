// Service worker NEO-SUSU : réseau d'abord, cache en secours (mode hors-ligne basique).
// Les appels à Supabase ne sont jamais mis en cache.
const CACHE = "neo-susu-v3";
const ASSETS = [
  "./", "./index.html", "./login.html", "./signup.html", "./dashboard.html",
  "./create-tontine.html", "./join-tontine.html", "./tontine-detail.html", "./profile.html",
  "./reset-password.html", "./neo-susu.css", "./app.js", "./config.js", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
