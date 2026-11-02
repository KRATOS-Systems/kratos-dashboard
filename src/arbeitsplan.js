import { useCallback, useEffect, useMemo, useState } from "react";
import { pollEvery } from "./poll.js";

// Arbeitspläne der Fertigungsaufträge aus Odoo (Reihenfolge, Maschine, Status, Zeiten), Server: /api/planung/arbeitsplaene.

// Arbeitsplatz in Odoo je Maschine der Planung (wie PLAN_MACHINES in server/bdeLaufzeit.js)
export const ODOO_CENTER = { dmu40: "DMU 40 EVO", dmu50: "DMU 50", m1: "DMG M1", h800u: "POS H 800 U" };
const lc = (v) => String(v || "").trim().toLowerCase();
const BASE = (center) => lc(center).replace(/\s+rüsten$/, "");

// Maschine der Planung zu einem Arbeitsplatz in Odoo ("DMU 40 EVO", "DMU 40 EVO Rüsten"); Sammelplätze (FRÄSEN, RÜSTEN) gehören keiner Maschine
export function machineIdOfCenter(center) {
  const base = BASE(center);
  return Object.keys(ODOO_CENTER).find((id) => lc(ODOO_CENTER[id]) === base) || null;
}

export const STEP_LABEL = { Programmierung: "Programmierung", Rüsten: "Rüsten", Fräsen: "Fräsen", QS: "QS" };
export const STATE_LABEL = { blocked: "wartet", pending: "wartet", waiting: "wartet", ready: "bereit", progress: "läuft", pause: "pausiert", done: "fertig" };
const UNSTARTED = ["blocked", "pending", "waiting", "ready"];
export const isUnstarted = (s) => UNSTARTED.includes(s.state) && !(s.durationMin > 0);

// Abweichung der Karte von Odoo: Das offene Rüsten und Fräsen hängt in Odoo an einer anderen Maschine als die Karte und kein offenes Fräsen steht
// auf der Maschine der Karte (ein zweiter Arbeitsschritt auf einer anderen Maschine ist gewollt und keine Abweichung).
// Liefert { steps: [...], fromId, canFix } oder null. canFix: alles Betroffene ist noch nicht begonnen, dann kann die App es umstellen.
export function deviation(steps, cardMachineId) {
  if (!steps || !cardMachineId || !ODOO_CENTER[cardMachineId]) return null;
  const open = steps.filter((s) => (s.step === "Fräsen" || s.step === "Rüsten") && s.state !== "done");
  if (open.some((s) => s.step === "Fräsen" && machineIdOfCenter(s.machine) === cardMachineId)) return null;
  const off = open.filter((s) => {
    const id = machineIdOfCenter(s.machine);
    return id && id !== cardMachineId;
  });
  if (!off.length) return null;
  // Stehen Rüsten und Fräsen auf mehreren fremden Maschinen, gilt die erste (so geht auch der Server vor), die anderen sind gewollte weitere Arbeitsschritte
  const fromId = machineIdOfCenter(off[0].machine);
  const mine = off.filter((s) => machineIdOfCenter(s.machine) === fromId);
  return { steps: mine, fromId, canFix: mine.every(isUnstarted) };
}

const CHUNK = 60;
// Holt die Arbeitspläne aller übergebenen Fertigungsaufträge (Odoo-Nummern), alle 2 Minuten neu und beim Zurückkehren ins Fenster
export function useArbeitsplaene(productionIds) {
  const key = useMemo(() => [...new Set(productionIds.filter(Number.isInteger))].sort((a, b) => a - b).join(","), [productionIds]);
  const [state, setState] = useState({ plans: {}, loaded: false, error: null });
  const load = useCallback(async () => {
    const ids = key ? key.split(",") : [];
    if (!ids.length) {
      setState({ plans: {}, loaded: true, error: null });
      return;
    }
    try {
      const plans = {};
      for (let i = 0; i < ids.length; i += CHUNK) {
        const r = await fetch(`/api/planung/arbeitsplaene?ids=${ids.slice(i, i + CHUNK).join(",")}`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "Arbeitspläne nicht verfügbar");
        Object.assign(plans, d.plans);
      }
      setState({ plans, loaded: true, error: null });
    } catch (err) {
      setState((s) => ({ ...s, loaded: true, error: err.message }));
    }
  }, [key]);
  useEffect(() => {
    load();
    return pollEvery(load, 2 * 60 * 1000);
  }, [load]);
  return { ...state, reload: load };
}

// Maschine in Odoo auf die der Karte umstellen (nur wenn noch nichts begonnen hat); Ergebnis { status, text }
export async function fixInOdoo(orderId, fromId) {
  const r = await fetch("/api/planung/odoo-maschine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId, from: fromId || "" }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
  return d;
}
