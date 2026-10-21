// Arbeitsvorbereitung (AV): Punkte der Checkliste je Position und deren Auswertung.
// Die Checkliste liegt in der Tabelle av_checks; ohne Zeile gilt der Standard (AV_DEFAULT).
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
export const avDone = (status) => status === "bereit" || status === "entfaellt";

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
