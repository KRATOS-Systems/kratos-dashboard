// Zeiten aus der Kalkulations-App (kalkulation.kratos-precision.de) über deren Schnittstelle /api/ext.
//
// - lookup: nur lesen. Sucht das Teil über die Zeichnungsnummer; ist es dort schon kalkuliert, liefert es Zeiten, Werkstoff, Rohteil,
//   Maschine und die Zeitbasis (Wiederholteil mit Ist-Zeiten, ähnliches Teil, Modell-Schätzung).
// - calculate: legt ein noch nicht kalkuliertes Teil in der Kalkulation an und rechnet es (STEP-Analyse, kann Minuten dauern).
//   Nur auf ausdrücklichen Knopfdruck eines Menschen, nie im Hintergrund. In Odoo schreibt die Kalkulation dabei nichts.
// Zugang: KALKULATION_URL (Standard https://kalkulation.kratos-precision.de) und KALKULATION_API_KEY (mind. 32 Zeichen). Ohne Schlüssel aus.

const CACHE_MS = 6 * 3600 * 1000;

export function kalkFromEnv(env = process.env) {
  const url = (env.KALKULATION_URL || "https://kalkulation.kratos-precision.de").replace(/\/+$/, "");
  const key = env.KALKULATION_API_KEY || "";
  const enabled = key.length >= 32;
  const cache = new Map(); // Zeichnungsnummer|Menge -> { at, value }

  async function call(method, path, body, timeoutMs = 30000) {
    const res = await fetch(url + "/api/ext" + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 300) throw new Error(data.error || `Kalkulation antwortete mit HTTP ${res.status}`);
    return data;
  }

  // Kompaktes Ergebnis für die App: Stunden für die Menge, Quelle, Werkstoff, Rohteil, Maschine
  const summarize = (p, qty) => {
    const t = p.times || {};
    const setup = Number(t.setupMin) || 0;
    const perPiece = Number(t.machiningMinPerPiece) || 0;
    const q = qty > 0 ? qty : 1;
    const hours = perPiece > 0 ? Math.max(0.5, Math.ceil(((setup + perPiece * q) / 60) * 2) / 2) : null;
    return {
      partId: p.partId,
      link: p.link || null,
      hours,
      setupMin: setup,
      perPieceMin: perPiece,
      programmingMin: Number(t.programmingMin) || 0,
      material: p.material || null,
      rawPart: p.rawPart || null,
      machine: p.machine || null,
      basis: p.timeBasis || null,
      confidence: p.confidence || null,
      reference: p.reference || null,
    };
  };

  // Nur lesen: ist das Teil schon in der Kalkulation? Dann deren Zeiten.
  async function lookup(code, qty) {
    if (!enabled || !code) return null;
    const k = `${code}|${qty || 0}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const found = await call("GET", "/products?q=" + encodeURIComponent(code));
    const list = Array.isArray(found.products) ? found.products : [];
    const exact = list.find((p) => !p.byName && String(p.code || "").toLowerCase() === code.toLowerCase());
    let value = { known: false, productId: exact ? exact.id : null };
    if (exact && exact.partId) {
      const r = await call("GET", `/parts/${exact.partId}?qty=${qty > 0 ? qty : ""}`);
      value = { known: true, productId: exact.id, ...summarize(r.part || {}, qty) };
    }
    cache.set(k, { at: Date.now(), value });
    return value;
  }

  // Auf Knopfdruck: Teil in der Kalkulation anlegen und rechnen
  async function calculate(productId, qty, code) {
    if (!enabled) throw new Error("Die Kalkulation ist nicht angebunden (KALKULATION_API_KEY fehlt).");
    if (!productId && !code) throw new Error("Ohne Odoo-Produkt oder Zeichnungsnummer kann die Kalkulation nicht rechnen.");
    const r = await call("POST", "/calculate", { ...(productId ? { product: productId } : { code }), qty: qty > 0 ? [qty] : undefined }, 180000);
    for (const key of [...cache.keys()]) cache.delete(key);
    return { known: true, productId, ...summarize(r.part || {}, qty), newlyImported: !!(r.part && r.part.newlyImported) };
  }

  const isCached = (code, qty) => {
    const hit = cache.get(`${code}|${qty || 0}`);
    return !!hit && Date.now() - hit.at < CACHE_MS;
  };

  return { enabled, url, lookup, calculate, isCached };
}

// Zeichnungsnummer aus dem Odoo-Produktnamen "[CODE] Bezeichnung"
export const codeOf = (product) => {
  const m = /^\s*\[([^\]]+)\]/.exec(String(product || ""));
  return m ? m[1].trim() : null;
};
