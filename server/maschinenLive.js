// Live-Daten der Maschinen aus dem KRATOS Maschinen-Dienst (läuft im Firmennetz, liest die Heidenhain-Steuerungen nur lesend).
//
// Der Dienst SCHICKT seinen Stand alle paar Sekunden hierher (POST /api/maschinen/eingang, Kopf X-Maschinen-Key = MASCHINEN_KEY).
// Das Dashboard fragt die Maschinen nie selbst ab. Ohne MASCHINEN_KEY ist der Eingang aus (404) und die Ampel bleibt wie bisher (nur Stempel).
// Der Stand liegt nur im Speicher: nach einem Neustart ist er nach dem nächsten Senden (wenige Sekunden) wieder da.
// Älter als STALE_MS gilt als „keine Verbindung“ – dann zeigt die Ampel wieder nur die Stempel.
//
// ampelZustand() verbindet Stempel und Maschine:
//   grün  lauf      Maschine arbeitet ein Programm ab
//   gelb  pause     Programm unterbrochen (Stopp, M0, Messen)
//   gelb  ruesten   Rüsten gestempelt, Maschine arbeitet nicht
//   rot   stoerung  Steuerung meldet einen Fehler
//   rot   steht     nichts läuft, obwohl Arbeitszeit ist und Arbeit wartet
//   –     frei      nichts zu tun
// dazu ein Hinweis, wenn Stempel und Maschine nicht zusammenpassen.

import { timingSafeEqual } from "node:crypto";
import express from "express";

export const STALE_MS = 90 * 1000;
export const HINWEIS_STEHT_MIN = 15; // Fräsen gestempelt, Maschine arbeitet seit so vielen Minuten nicht → Hinweis
export const HINWEIS_OHNE_STEMPEL_MIN = 5; // Maschine arbeitet seit so vielen Minuten ohne gestempeltes Fräsen → Hinweis
const IDS = ["dmu40", "dmu50", "m1", "h800u"];

let stand = { empfangen: 0, maschinen: {} };

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const txt = (v, n = 200) => (v === null || v === undefined ? null : String(v).slice(0, n));

// nur bekannte Felder übernehmen, alles andere verwerfen
export function sauber(m) {
  if (!m || typeof m !== "object" || !IDS.includes(m.id)) return null;
  const achsen = {};
  if (m.achsen && typeof m.achsen === "object") for (const [k, v] of Object.entries(m.achsen).slice(0, 9)) if (/^[A-Z0-9]$/.test(k) && num(v) !== null) achsen[k] = v;
  return {
    id: m.id,
    zustand: ["laeuft", "unterbrochen", "stoerung", "bereit", "offline", "keine_daten"].includes(m.zustand) ? m.zustand : "keine_daten",
    seit: txt(m.seit, 30),
    programm: txt(m.programm, 120),
    zeile: num(m.zeile),
    werkzeug: num(m.werkzeug),
    spindel: ["rechts", "links", "aus"].includes(m.spindel) ? m.spindel : null,
    vorschub: num(m.vorschub_override),
    fehler: Array.isArray(m.fehler) ? m.fehler.slice(0, 5).map((f) => txt(f)) : [],
    achsen: Object.keys(achsen).length ? achsen : null,
    abfrage: txt(m.letzte_abfrage, 30),
  };
}

export function liveStand(now = Date.now()) {
  if (!stand.empfangen || now - stand.empfangen > STALE_MS) return {};
  return stand.maschinen;
}

// Minuten seit einem ISO-Zeitpunkt des Dienstes (Ortszeit des Dienst-PCs, ohne Zone → als Europe/Berlin gemeint; Abweichung durch Sommerzeit egal für Minuten-Hinweise)
function minutenSeit(iso, now) {
  if (!iso) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + berlinOffset(now));
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60000) : null;
}
function berlinOffset(now) {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", timeZoneName: "longOffset" }).formatToParts(new Date(now)).find((p) => p.type === "timeZoneName")?.value || "GMT+01:00";
  const m = s.match(/GMT([+-]\d\d):?(\d\d)?/);
  return m ? `${m[1]}:${m[2] || "00"}` : "+01:00";
}

/**
 * @param {string} stempelState  Zustand nur aus den Stempeln: lauf | ruesten | steht | frei
 * @param {object[]} runs        gestempelte Läufe der Maschine ({ step: "Fräsen" | "Rüsten", ... })
 * @param {object|null} live     Live-Daten der Maschine (sauber()) oder null
 * @param {{ working: boolean, waiting: number, now?: number }} o
 */
export function ampelZustand(stempelState, runs, live, { working, waiting, now = Date.now() }) {
  const usable = live && !["offline", "keine_daten"].includes(live.zustand);
  if (!usable) return { state: stempelState, quelle: "stempel", hinweis: null };
  const fraesen = runs.some((r) => r.step === "Fräsen");
  const ruesten = runs.some((r) => r.step === "Rüsten");
  const min = minutenSeit(live.seit, now);
  let state;
  if (live.zustand === "stoerung") state = "stoerung";
  else if (live.zustand === "laeuft") state = "lauf";
  else if (live.zustand === "unterbrochen") state = "pause";
  else if (ruesten) state = "ruesten";
  else if (fraesen && min !== null && min < HINWEIS_STEHT_MIN) state = "ruesten"; // gerade gestempelt, Programm noch nicht gestartet
  else if (working && (waiting > 0 || fraesen)) state = "steht";
  else state = "frei";
  let hinweis = null;
  if (fraesen && live.zustand !== "laeuft" && min !== null && min >= HINWEIS_STEHT_MIN)
    hinweis = `Fräsen ist gestempelt, aber die Maschine arbeitet seit ${Math.round(min)} min nicht.`;
  else if (live.zustand === "laeuft" && !fraesen && min !== null && min >= HINWEIS_OHNE_STEMPEL_MIN)
    hinweis = `Die Maschine arbeitet seit ${Math.round(min)} min${live.programm ? ` (${live.programm})` : ""}, aber es ist kein Fräsen gestempelt.`;
  return { state, quelle: "maschine", hinweis };
}

// Eingang: VOR dem Passwortschutz registrieren (eigener Schutz über MASCHINEN_KEY)
export function registerMaschinenEingang(app, key = process.env.MASCHINEN_KEY || "") {
  app.post("/api/maschinen/eingang", express.json({ limit: "64kb" }), (req, res) => {
    if (!key || key.length < 16) return res.status(404).json({ error: "Nicht eingerichtet" });
    if (!same(req.get("X-Maschinen-Key") || "", key)) return res.status(401).json({ error: "Schlüssel falsch" });
    const liste = Array.isArray(req.body && req.body.maschinen) ? req.body.maschinen : [];
    const neu = {};
    for (const m of liste.slice(0, 10)) {
      const s = sauber(m);
      if (s) neu[s.id] = s;
    }
    stand = { empfangen: Date.now(), maschinen: neu };
    res.json({ ok: true, maschinen: Object.keys(neu) });
  });
}

// Lesen (hinter dem Passwortschutz)
export function registerMaschinenLive(app) {
  app.get("/api/maschinen/live", (req, res) => {
    const m = liveStand();
    res.json({ empfangen: stand.empfangen || null, aktuell: Object.keys(m).length > 0, maschinen: m });
  });
}

// nur für Tests
export function _setStand(s) {
  stand = s;
}
