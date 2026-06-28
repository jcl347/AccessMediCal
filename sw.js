/* Access Medi-Cal LA service worker - offline support + faster repeat visits.
   App shell (HTML/JS/CSS/manifest) is NETWORK-FIRST so a new deploy shows on the
   next load (cache-first made updates lag a reload or two); it falls back to cache
   only when offline. Other same-origin static (icons/images) and cross-origin assets
   (fonts, Leaflet, tiles) are cache-first. The dynamic /api/ endpoints are always
   network with graceful offline JSON. */
var CACHE = "amla-v45";
var CORE = ["./", "./index.html", "./css/styles.css", "./js/app.js", "./js/data.js", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Live/dynamic APIs: always network; offline -> graceful JSON so the app can degrade.
  if (url.origin === location.origin && url.pathname.indexOf("/api/") === 0) {
    e.respondWith(fetch(req).catch(function () {
      return new Response(JSON.stringify({ ok: false, error: "offline" }), { headers: { "Content-Type": "application/json" } });
    }));
    return;
  }

  if (url.origin === location.origin) {
    // App shell (HTML + JS/CSS/data/manifest): NETWORK-FIRST so a fresh deploy is seen on the
    // next load; fall back to cache only when the network fails (offline).
    var shell = req.mode === "navigate" || url.pathname === "/" || /\.(?:html|js|css|webmanifest)$/.test(url.pathname);
    if (shell) {
      e.respondWith(fetch(req).then(function (res) {
        if (res && res.status === 200) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () { return caches.match(req).then(function (c) { return c || caches.match("./index.html"); }); }));
      return;
    }
    // Other same-origin static (icons/images): cache-first, refresh in background.
    e.respondWith(caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () { return cached || caches.match("./index.html"); });
      return cached || net;
    }));
    return;
  }

  // Cross-origin (fonts, Leaflet, tiles, images): cache-first runtime.
  e.respondWith(caches.match(req).then(function (cached) {
    return cached || fetch(req).then(function (res) {
      try { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); } catch (_) {}
      return res;
    }).catch(function () { return cached; });
  }));
});
