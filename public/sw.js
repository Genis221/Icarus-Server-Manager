/* Icarus Server Manager — installability / light offline shell */
const CACHE = "icarus-manager-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icarus-icon.png",
  "/icarus-icon-192.png",
  "/icarus-icon-512.png",
  "/icarus-icon.ico"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache live API / SSE / console streams.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        if (res.ok && (url.pathname === "/" || SHELL.includes(url.pathname))) {
          caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(cached => cached || caches.match("/index.html"))
      )
  );
});
