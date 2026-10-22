import { useEffect, useState } from "react";

// Hilfen für die Betriebsdatenerfassung: Uhr, Zeitformate (immer Europe/Berlin), Artikel, Odoo-Verweis

const TZ = "Europe/Berlin";

// Aktuelle Zeit, die jede Sekunde weiterläuft
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// Laufzeit als Uhr: "0:38" (Stunden:Minuten) und Sekunden extra; ab einem Tag in Tagen
export function clock(start, now) {
  const s = Math.max(0, Math.floor((now - start) / 1000));
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    return { main: `${d} ${d === 1 ? "Tag" : "Tage"}`, sec: "" };
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return { main: `${h}:${String(m).padStart(2, "0")}`, sec: String(s % 60).padStart(2, "0") };
}

const timeFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export const fmtTime = (ms) => timeFmt.format(new Date(ms));

// "seit 7:12" heute, sonst "seit 02.06., 15:16"
export function since(ms, now = Date.now()) {
  const d = new Date(ms);
  return dayKey.format(d) === dayKey.format(new Date(now)) ? `seit ${timeFmt.format(d)}` : `seit ${dayFmt.format(d)}, ${timeFmt.format(d)}`;
}

// Stunden als "31:20 h"
export function hm(hours) {
  if (hours == null) return "–";
  const sign = hours < 0 ? "−" : "";
  const min = Math.round(Math.abs(hours) * 60);
  return `${sign}${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

// "[KSS.P2322-361] Grundplatte Bauteilaufnahme" -> Name und Artikelnummer
export function splitProduct(p) {
  if (!p) return { name: null, code: null };
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(p);
  return m ? { name: m[2] || m[1], code: m[1] } : { name: p, code: null };
}

export const odooLink = (base, productionId) => (base && productionId ? `${base}/odoo/manufacturing/${productionId}` : null);

// Buchen über den Server (Wechseln, Unterbrechen, Weiter, Stopp); wirft mit lesbarer Meldung
export async function act(body) {
  const r = await fetch("/api/bde/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
  return d;
}

// Angemeldet? Darf auf diesem Gerät bedient werden? (Am Handy nur Anzeige)
export function useBdeSession(refreshKey) {
  const [s, setS] = useState(null);
  useEffect(() => {
    fetch("/api/bde/session")
      .then((r) => r.json())
      .then(setS)
      .catch(() => setS(null));
  }, [refreshKey]);
  return s;
}
export const isPhoneView = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse) and (max-width: 700px)").matches;
export const canOperate = (s) => !!(s && s.id && s.write && !s.phone && !isPhoneView());

// Wert für <input type="datetime-local"> in Berliner Zeit
export function toLocalInput(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
// und zurück: "2026-10-21T22:10" (Berlin) -> Zeitpunkt
export function fromLocalInput(s) {
  const [d, t] = s.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, day, h, mi);
  const off = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  return guess - off(guess - off(guess));
}

export const initials = (name) =>
  String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
