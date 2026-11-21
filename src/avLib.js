// Arbeitsvorbereitung (AV): Punkte der Checkliste je Position und deren Auswertung.
// Die Checkliste liegt in der Tabelle av_checks; ohne Zeile gilt der Standard (AV_DEFAULT).
// Wer in der Arbeitsvorbereitung zuständig sein kann (Auswahlliste)
export const AV_TEAM = ["Frank", "Nino", "Aurel", "Alex B.", "Alex M."];

export const AV_ITEMS = [
  { id: "material", label: "Material", hint: "z. B. Werkstoff, Lieferant, bestellt am" },
  { id: "programm", label: "Programm", hint: "CAM-Programm erstellt und geprüft" },
  { id: "werkzeuge", label: "Werkzeuge", hint: "z. B. Fräser Ø10, bestellt im Portal" },
  { id: "spannmittel", label: "Spannmittel", hint: "Vorrichtung, Spannbacken" },
  { id: "pruefplan", label: "Prüfplan", hint: "Prüfplan für die Fertigung (tolerierte Maße)" },
  { id: "empb", label: "EMPB", hint: "Erstmusterprüfbericht (Kunde verlangt ihn)" },
];

export const AV_DEFAULT = {
  material: "offen",
  programm: "offen",
  werkzeuge: "offen",
  spannmittel: "offen",
  pruefplan: "entfaellt",
  empb: "entfaellt",
};

export const AV_STATUS = [
  { id: "entfaellt", label: "nicht nötig", short: "–" },
  { id: "offen", label: "offen", short: "offen" },
  { id: "in_arbeit", label: "in Arbeit", short: "in Arbeit" },
  { id: "bereit", label: "bereit", short: "bereit" },
];

export const avKey = (id, item) => `${id}|${item}`;
export const avState = (checks, id, item) => checks.get(avKey(id, item)) || { status: AV_DEFAULT[item], due: null, note: "", assignee: null };
// Wurde in der Checkliste schon etwas bearbeitet (Status geändert, Termin oder Notiz)? Der vorbelegte Zuständige zählt nicht.
export const avStarted = (checks, id) =>
  AV_ITEMS.some((it) => {
    const s = avState(checks, id, it.id);
    if (s.auto) return false; // automatisch aus QS/Odoo gesetzt (Prüfplan, EMPB): zählt nicht als bearbeitet
    return s.status !== AV_DEFAULT[it.id] || !!s.due || !!(s.note && s.note.trim());
  });
// Aus Odoo neu übernommen: "NEU" in der Arbeitsvorbereitung, bis dort etwas bearbeitet wurde
export const isNewAv = (o, checks) => !!o.new_since && !o.done && !avStarted(checks, o.id);
export const avDone = (status) => status === "bereit" || status === "entfaellt";

// Startklar: Kann die Position auf der Maschine wirklich anfangen? Eingeplant heißt das noch nicht.
// Fehlt etwas, gibt es die Liste zurück (leer = startklar). Laufende oder erledigte Positionen und Extern/QS: null (keine Aussage).
export function startklar(o, checks) {
  if (!o || o.done || !o.machine || ["qs", "extern", "extern_fert", "versand"].includes(o.machine)) return null;
  if ((o.done_hours || 0) > 0 || o.progress_date) return null;
  const fehlt = [];
  if (!(o.hours > 0)) fehlt.push("Stunden");
  if (o.odoo_bom === "muster") fehlt.push("Musterwerte");
  if (o.odoo_bom === "none" || o.odoo_bom === "leer") fehlt.push("Stückliste");
  if (o.odoo_draft) fehlt.push("FA im Entwurf");
  if (!avDone(avState(checks, o.id, "material").status)) fehlt.push(/noch nicht bestellt/.test(o.material_info || "") ? "Material klären" : "Material");
  if (!avDone(avState(checks, o.id, "programm").status)) fehlt.push("Programm");
  return fehlt;
}

// offen -> in Arbeit -> bereit -> offen (ein nicht nötiger Punkt wird mit einem Klick offen)
export const avCycle = (status) => (status === "offen" ? "in_arbeit" : status === "in_arbeit" ? "bereit" : "offen");

// Zusammenfassung einer Position: bereit, Ampel (red/amber/green), offene Punkte, spätester Termin der offenen Punkte
export function avSummary(checks, id) {
  const states = AV_ITEMS.map((it) => ({ ...it, ...avState(checks, id, it.id) }));
  const open = states.filter((s) => !avDone(s.status));
  const level = states.some((s) => s.status === "offen") ? "red" : states.some((s) => s.status === "in_arbeit") ? "amber" : "green";
  const dates = open.map((s) => s.due).filter(Boolean).sort();
  return { states, open, ready: open.length === 0, level, readyDate: dates.length ? dates[dates.length - 1] : null };
}

// Prüfplan und EMPB entstehen in QS (app.dynamis-systems.de/qs). Der Link öffnet dort die Zeichnung zum Artikel
// (Artikel aus dem Odoo-Produktnamen „[Nummer] Name“, Fertigungsauftrag und Kundenauftrag zum Nachschlagen);
// gibt es noch keine, öffnet QS „Neue Zeichnung hinzufügen“ mit den Angaben vorbefüllt.
export const QS_ARTIKEL_URL = "https://app.dynamis-systems.de/qs/artikel";
export const QS_ITEMS = ["pruefplan", "empb"];
export function qsArtikelUrl(o, ziel = "pruefplan") {
  const p = new URLSearchParams();
  const m = String(o.product || "").match(/^\[([^\]]+)\]/);
  if (m) p.set("artikel", m[1].trim());
  const fa = o.odoo_ref || "";
  if (/^[A-Z]{1,4}[\d/]/i.test(fa) && !/^P\d/.test(fa)) p.set("fa", fa); // Fertigungsauftrag, keine Einkaufsbestellung
  if (o.source) p.set("auftrag", o.source);
  p.set("ziel", ziel);
  return QS_ARTIKEL_URL + "?" + p.toString();
}
