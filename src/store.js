// Kleiner gemeinsamer Speicher: Das Dashboard legt seine Kennzahlen ab, damit Talos (Suche) sie beantworten kann.
let dash = null;
export const setDashFacts = (f) => {
  dash = f;
};
export const getDashFacts = () => dash;
