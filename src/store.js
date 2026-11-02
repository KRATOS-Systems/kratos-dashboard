// Kleiner gemeinsamer Speicher: Das Dashboard legt seine Kennzahlen ab, damit Talos (Suche) sie beantworten kann.
let dash = null;
const subs = new Set();
export const setDashFacts = (f) => {
  dash = f;
  subs.forEach((fn) => fn());
};
export const getDashFacts = () => dash;
// Für die rechte Leiste: meldet sich, wenn das Dashboard neue Kennzahlen ablegt
export const subscribeDashFacts = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
