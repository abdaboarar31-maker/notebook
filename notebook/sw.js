// Service worker: works offline + shows the reminder notification when the server sends a push.
const CACHE = "wn-v1.1.0";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== "wn-meta").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// network first (so updates arrive), cache as the offline fallback
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});

const T = {
  ar: ["📒 هل سجّلت يوم عملك؟", "اضغط لتسجيل يومك في ثوانٍ."],
  he: ["📒 רשמת את יום העבודה?", "לחצו כדי לרשום בשניות."],
  en: ["📒 Did you log today?", "Tap to log your day in seconds."],
};

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let l = "ar";
    try { const c = await caches.open("wn-meta"); const r = await c.match("lang"); if (r) l = (await r.text()) || "ar"; } catch (x) {}
    const t = T[l] || T.ar;
    await self.registration.showNotification(t[0], {
      body: t[1], icon: "icon-192.png", badge: "icon-192.png", tag: "wn-reminder", data: { url: "./" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ("focus" in c) return c.focus();
      return clients.openWindow("./");
    })
  );
});
