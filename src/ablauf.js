// Ablauf je Auftrag (Schritt 4): acht feste Schritte, aus den Daten der App berechnet (nichts wird extra gepflegt).
//   1 Auftrag da · 2 Zeiten · 3 Material · 4 FA freigegeben · 5 Eingeplant · 6 AV fertig · 7 Fertigung · 8 QS / Extern / Lieferung
// Ein Schritt ist erledigt, wenn er für alle offenen Positionen des Auftrags erledigt ist. Der erste nicht erledigte Schritt ist
// „als Nächstes zu tun“ (now), spätere nicht erledigte sind offen (open). Laufende und erledigte Positionen zählen bei den
// Vorbereitungs-Schritten nicht mehr mit (was schon gefräst wird, braucht kein Material mehr).

import { avState, avDone, avSummary, materialStand } from "./avLib.js";

const LANES = ["qs", "extern", "extern_fert", "versand"];
export const ABLAUF_SCHRITTE = [
  { id: "da", label: "Auftrag da" },
  { id: "zeiten", label: "Zeiten & Stückliste" },
  { id: "material", label: "Material" },
  { id: "fa", label: "FA freigegeben" },
  { id: "plan", label: "Eingeplant" },
  { id: "av", label: "AV fertig" },
  { id: "fertigung", label: "Fertigung" },
  { id: "qs", label: "QS · Extern · Lieferung" },
];
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

export function ablaufOf(positions, checks) {
  const open = positions.filter((o) => !o.done);
  const started = (o) => (o.done_hours || 0) > 0 || !!o.progress_date || LANES.includes(o.machine);
  const vor = open.filter((o) => !started(o)); // noch nicht begonnen: hier zählen die Vorbereitungs-Schritte
  const onMachine = open.filter((o) => o.machine && !LANES.includes(o.machine));
  const inLane = open.filter((o) => LANES.includes(o.machine));
  const ref = (list) => list.slice(0, 3).map((o) => o.order_no || o.odoo_ref || "#" + o.id).join(", ") + (list.length > 3 ? " …" : "");
  const r = {};

  r.da = { done: true, detail: positions[0] && positions[0].sale_date ? "seit " + positions[0].sale_date.split("-").reverse().join(".") : "" };

  const zeiten = vor.filter((o) => !(o.hours > 0) || ["muster", "none", "leer"].includes(o.odoo_bom));
  r.zeiten = { done: !zeiten.length, ids: zeiten.map((o) => o.id), detail: zeiten.length ? `${ref(zeiten)}: ${zeiten.some((o) => !(o.hours > 0)) ? "Stunden fehlen" : "Musterwerte / Stückliste"}` : "Zeiten und Stückliste da" };

  const mat = vor.filter((o) => !avDone(avState(checks, o.id, "material").status));
  const nb = mat.filter((o) => /noch nicht bestellt/.test(o.material_info || ""));
  const unterwegs = mat.filter((o) => o.material_date && !/noch nicht bestellt/.test(o.material_info || ""));
  // Widerspruch AV ↔ Odoo: nicht als erledigt zählen, sondern zum Klären melden (gleiche Regel wie das Etikett oben im Fenster)
  const wider = vor.filter((o) => (materialStand(o, checks) || {}).st === "widerspruch");
  r.material = {
    done: !mat.length && !wider.length,
    ids: (wider.length ? wider : mat).map((o) => o.id),
    detail: wider.length ? `${ref(wider)}: AV sagt da, Odoo sagt fehlt, bitte klären` : !mat.length ? "Material da" : nb.length ? `${plural(nb.length, "Position", "Positionen")}: nur Anfrage in Odoo, Material klären` : unterwegs.length ? `bestellt, kommt ${unterwegs.map((o) => o.material_date).sort()[0].split("-").reverse().join(".").slice(0, 6)}` : `${ref(mat)}: Material anlegen oder bestellen`,
  };

  const fa = vor.filter((o) => o.odoo_draft);
  r.fa = { done: !fa.length, ids: fa.map((o) => o.id), detail: fa.length ? `${ref(fa)} im Entwurf: in Odoo bestätigen` : "bestätigt" };

  const pool = open.filter((o) => !o.machine);
  r.plan = { done: !pool.length, ids: pool.map((o) => o.id), detail: pool.length ? `${plural(pool.length, "Position", "Positionen")} ohne Maschine` : "alle eingeplant" };

  const avOpen = vor.filter((o) => !avSummary(checks, o.id).ready);
  const avItems = [...new Set(avOpen.flatMap((o) => avSummary(checks, o.id).open.map((s) => s.label)))];
  r.av = { done: !avOpen.length, ids: avOpen.map((o) => o.id), detail: avOpen.length ? `offen: ${avItems.join(", ")}` : "alles bereit" };

  const laeuft = onMachine.filter((o) => (o.done_hours || 0) > 0 || o.progress_date);
  r.fertigung = { done: !onMachine.length && !pool.length, ids: onMachine.map((o) => o.id), running: laeuft.length > 0, detail: !onMachine.length ? (pool.length ? "noch nicht eingeplant" : "Maschinenarbeit fertig") : laeuft.length ? `läuft: ${ref(laeuft)}` : `${plural(onMachine.length, "Position", "Positionen")} auf der Maschine` };

  const imVersand = inLane.filter((o) => o.machine === "versand");
  r.qs = {
    done: open.length === 0,
    ids: inLane.map((o) => o.id),
    detail:
      inLane.length && imVersand.length === inLane.length
        ? `${plural(imVersand.length, "Position", "Positionen")} versandbereit`
        : inLane.length
        ? `${plural(inLane.length - imVersand.length, "Position", "Positionen")} in QS oder extern${imVersand.length ? `, ${imVersand.length} versandbereit` : ""}`
        : open.length
        ? "nach der Fertigung"
        : "geliefert",
  };

  let nowSet = false;
  const steps = ABLAUF_SCHRITTE.map((s) => {
    const x = r[s.id];
    let state = x.done ? "done" : "open";
    if (!x.done && !nowSet) {
      state = "now";
      nowSet = true;
    }
    return { ...s, ...x, state };
  });
  const next = steps.find((s) => s.state === "now") || null;
  return { steps, next, doneCount: steps.filter((s) => s.state === "done").length };
}
