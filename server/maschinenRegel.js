// Welche Maschine darf die App von selbst wählen (Planvorschlag, Plan neu ordnen)?
//
// Fast alle Teile können auf allen Maschinen laufen, aber nicht auf jeder: Die M1 ist eingeschränkt (Hinweis von Alexander, 17.11.2026).
// Auf eine eingeschränkte Maschine legt die App ein Teil nur, wenn klar ist, dass es dort geht:
//   - die Maschine steht im Arbeitsplan in Odoo (odoo_machine)
//   - dasselbe Teil lief schon einmal auf dieser Maschine (erledigte Position, Wiederholteil)
//   - die Position steht schon auf dieser Maschine
//   - jemand hat an der Position "passt auf M1" angehakt (orders.restricted_ok)
// Von Hand ziehen geht immer, das prüft die App nicht.
// Welche Maschinen eingeschränkt sind: PLAN_EINGESCHRAENKT (Kommaliste der Maschinen-IDs), Standard "m1".

import { MACHINES } from "../src/lib.js";

const IDS = MACHINES.map((m) => m.id);
export const RESTRICTED = new Set(
  (process.env.PLAN_EINGESCHRAENKT === undefined ? "m1" : process.env.PLAN_EINGESCHRAENKT)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => IDS.includes(s))
);

// Maschinen, auf denen dasselbe Teil schon gelaufen ist (erledigte Positionen), je Teil
export function historyOf(orders) {
  const ran = new Map();
  orders
    .filter((o) => o.done && o.product)
    .forEach((o) => {
      const m = IDS.includes(o.machine) ? o.machine : IDS.includes(o.from_machine) ? o.from_machine : null;
      if (!m) return;
      if (!ran.has(o.product)) ran.set(o.product, new Set());
      ran.get(o.product).add(m);
    });
  return ran;
}

// allowed(o, mid): darf die App die Position o von selbst auf die Maschine mid legen?
export function makeAllowed(orders) {
  const ran = historyOf(orders);
  return (o, mid) => {
    if (!RESTRICTED.has(mid)) return true;
    if (o.restricted_ok) return true;
    if (o.machine === mid || o.odoo_machine === mid) return true;
    return !!o.product && !!ran.get(o.product)?.has(mid);
  };
}
