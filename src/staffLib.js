// Zuständigkeiten: wer macht was an einer Position. Wird von der Planung (Oberfläche) und vom Server (Mein Arbeitsplatz) benutzt.
//
// Regel (Nutzerentscheidung 22.10.2026):
// - Rüsten, Fräsen und Programmieren macht standardmäßig der Stammbediener der Maschine, auf der die Position eingeplant ist.
// - QS hat eine feste Rolle (Standard Aurel), die Arbeitsvorbereitung ebenfalls (Standard Nino), die Produktionsplanung Frank.
// - Je Position und Tätigkeit kann die Planung abweichen ("Programmierung: Frank").
// - In der Arbeitsvorbereitung gilt der Zuständige des AV-Punkts, ohne Eintrag die Rolle Arbeitsvorbereitung.
// Namen sind dieselben wie in der Arbeitsvorbereitung; die Odoo-Mitarbeiter-ID dient Mein Arbeitsplatz zur Zuordnung.

export const STAFF = [
  { name: "Frank", employeeId: 3 },
  { name: "Nino", employeeId: 11 },
  { name: "Aurel", employeeId: 2 },
  { name: "Alex B.", employeeId: 5 },
  { name: "Thomas", employeeId: 14 },
  { name: "Dardan", employeeId: 10 },
  { name: "Alex M.", employeeId: 1 },
];
export const staffName = (employeeId) => STAFF.find((s) => s.employeeId === employeeId)?.name || null;
export const staffId = (name) => STAFF.find((s) => s.name === name)?.employeeId ?? null;

// Tätigkeiten an einer Position (wie die Arbeitsgänge in Odoo)
export const ACTIVITIES = [
  { id: "programmierung", label: "Programmierung" },
  { id: "ruesten", label: "Rüsten" },
  { id: "fraesen", label: "Fräsen" },
  { id: "qs", label: "QS" },
];

// Standardwerte (Schlüssel der Tabelle staff_defaults)
export const STAFF_DEFAULTS = {
  "machine:dmu40": "Nino",
  "machine:m1": "Frank",
  "machine:h800u": "Aurel",
  "role:qs": "Aurel",
  "role:av": "Nino",
  "role:planung": "Frank",
  "role:programmierung": "", // leer = Stammbediener der Maschine
};
export const STAFF_KEYS = Object.keys(STAFF_DEFAULTS);

// Wer ist für eine Tätigkeit an einer Position zuständig? (null = noch niemand, z. B. ohne Maschine)
// order: { id, machine, from_machine }, defaults: { key: name }, overrides: Map("orderId|activity" -> name)
export function responsible(order, activity, defaults, overrides) {
  const own = overrides.get(`${order.id}|${activity}`);
  if (own) return own;
  if (activity === "qs") return defaults["role:qs"] || null;
  const machine = ["dmu40", "m1", "h800u"].includes(order.machine) ? order.machine : order.from_machine || null;
  const owner = machine ? defaults[`machine:${machine}`] || null : null;
  if (activity === "programmierung") return defaults["role:programmierung"] || owner;
  return owner;
}
