import { addDays } from "./lib.js";

// Ostersonntag nach der Gaußschen Osterformel (Meeus/Jones/Butcher), als "YYYY-MM-DD"
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Gesetzliche Feiertage in Bayern. Mariä Himmelfahrt gilt in Gemeinden mit überwiegend
// katholischer Bevölkerung (die meisten), der Augsburger Friedensfest-Tag fehlt bewusst.
export function holidaysBavaria(year) {
  const easter = easterSunday(year);
  const fixed = (mmdd, name) => ({ date: `${year}-${mmdd}`, name });
  return [
    fixed("01-01", "Neujahr"),
    fixed("01-06", "Heilige Drei Könige"),
    { date: addDays(easter, -2), name: "Karfreitag" },
    { date: addDays(easter, 1), name: "Ostermontag" },
    fixed("05-01", "Tag der Arbeit"),
    { date: addDays(easter, 39), name: "Christi Himmelfahrt" },
    { date: addDays(easter, 50), name: "Pfingstmontag" },
    { date: addDays(easter, 60), name: "Fronleichnam" },
    fixed("08-15", "Mariä Himmelfahrt"),
    fixed("10-03", "Tag der Deutschen Einheit"),
    fixed("11-01", "Allerheiligen"),
    fixed("12-25", "1. Weihnachtstag"),
    fixed("12-26", "2. Weihnachtstag"),
  ].sort((x, y) => x.date.localeCompare(y.date));
}
