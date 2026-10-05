export const MACHINES = [
  { id: "dmu40", name: "DMG DMU 40 eVo", short: "DMU 40", colorKey: "blue" },
  { id: "m1", name: "DMG M1", short: "M1", colorKey: "yellow" },
  { id: "h800u", name: "POS Mill H800U", short: "H800U", colorKey: "red" },
];

export const DAY = 86400000;

// Stunden mit Dezimalkomma
export function fmtH(x) {
  return x == null ? "–" : `${Math.round(x * 10) / 10}`.replace(".", ",");
}

// Schichtmodelle: Betriebszeit in Stunden pro Woche (für alle Maschinen)
export const SHIFT_MODELS = [
  { label: "Normalschicht", hours: 50 },
  { label: "Früh + Spät", hours: 75 },
  { label: "Früh + Spät + Nacht", hours: 100 },
];
export const DEFAULT_WEEK_CAPACITY = 75;

// Datumshelfer: Daten sind Strings "YYYY-MM-DD", gerechnet wird in UTC
export const toMs = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
export const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => fromMs(toMs(s) + n * DAY);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
export const fmtShort = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.`;

export function todayStr() {
  const n = new Date();
  return fromMs(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

export function mondayOf(s) {
  const dow = new Date(toMs(s)).getUTCDay() || 7;
  return addDays(s, 1 - dow);
}

export function isoWeekOf(s) {
  const d = new Date(toMs(s));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / DAY + 1) / 7) };
}

export function weekInfo(monday) {
  const { year, week } = isoWeekOf(monday);
  return { key: `${year}-${week}`, label: `KW ${week}`, monday };
}

export function makeStyles(theme) {
  return {
    eyebrow: {
      fontSize: 10,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: theme.steel,
      fontWeight: 600,
    },
    mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  };
}
