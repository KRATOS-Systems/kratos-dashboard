// Offline-Stand: Ist der Server nicht erreichbar, öffnet sich die App trotzdem und zeigt den letzten Stand der Planung zum Ansehen.
//
// - Seiten (HTML): zuerst vom Server, bei Fehler, Zeitüberschreitung oder 502/503/504 die zuletzt gemerkte Fassung.
// - Programmdateien (/assets/): einmal geladen, bleiben sie im Gerät (Dateinamen enthalten den Inhalt, ändern sich also mit jeder Version).
// - Planungsdaten (nur die Liste unten, GET): zuerst vom Server, sonst der letzte Stand. Die Antwort aus dem Gerät trägt den Kopf
//   "x-offline-stand" mit dem Zeitpunkt, daran erkennt die App, dass sie alte Daten zeigt.
// Nichts Persönliches wird gemerkt: kein /api/bde/*, keine Anmeldung, keine Bilder, keine Rückmeldungen. Schreibzugriffe laufen nie über den Speicher.
// Antwortet der Server mit 401 (Anmeldung), wird das unverändert durchgereicht.

const VERSION = "v1";
const PAGES = `kratos-seiten-${VERSION}`;
const ASSETS = `kratos-programm-${VERSION}`;
const DATA = `kratos-daten-${VERSION}`;
const KEEP = [PAGES, ASSETS, DATA];
const MAX_ASSETS = 150;
const PAGE_WAIT_MS = 6000;
const DATA_WAIT_MS = 8000;
const DATA_RE = /^\/api\/(orders|week-capacity|readings|free-days|plan-settings|plan-rates|av|staff|staff\/defaults|staff\/order|staff\/info|odoo\/status)$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("kratos-") && !KEEP.includes(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

async function stamped(res) {
  const h = new Headers(res.headers);
  h.set("x-cached-at", new Date().toISOString());
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: h });
}
function fromMemory(res) {
  const h = new Headers(res.headers);
  h.set("x-offline-stand", res.headers.get("x-cached-at") || "");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Zuerst Server; bei Ausfall oder Warten über die Frist hinaus der gemerkte Stand
function networkFirst(req, cacheName, waitMs, key) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (r) => {
      if (!answered) {
        answered = true;
        resolve(r);
      }
    };
    const fallback = async () => {
      const cached = await (await caches.open(cacheName)).match(key);
      return cached ? fromMemory(cached) : null;
    };
    const timer = setTimeout(async () => {
      const f = await fallback();
      if (f) answer(f);
    }, waitMs);
    fetch(req)
      .then(async (res) => {
        clearTimeout(timer);
        if (res.ok) {
          const copy = res.clone();
          (async () => (await caches.open(cacheName)).put(key, await stamped(copy)))().catch(() => {});
        }
        if (res.status >= 502 && res.status <= 504) {
          const f = await fallback();
          if (f) return answer(f);
        }
        answer(res);
      })
      .catch(async () => {
        clearTimeout(timer);
        const f = await fallback();
        answer(f || Response.error());
      });
  });
}

async function assetFirst(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req, PAGES, PAGE_WAIT_MS, url.origin + url.pathname));
  } else if (url.pathname.startsWith("/assets/")) {
    e.respondWith(assetFirst(req));
  } else if (DATA_RE.test(url.pathname)) {
    e.respondWith(networkFirst(req, DATA, DATA_WAIT_MS, req.url));
  }
});
