// Gemeinsamer Takt für alle Seiten, die sich von selbst aktualisieren.
//   - Ist das Fenster im Hintergrund (anderer Tab, minimiert, Bildschirm aus), wird nicht abgefragt.
//   - Kommt man zurück, wird sofort einmal neu geladen.
//   - Antwortet der Server mehrfach hintereinander mit 401 (Anmeldung abgelaufen), wird nicht weiter abgefragt, bis man zurückkehrt.
// Die Abstände bleiben wie sie waren.

const MAX_401 = 3;
const MIN_GAP_MS = 5000;

let unauthorized = 0;

if (typeof window !== "undefined" && typeof window.fetch === "function" && !window.__pollGuard) {
  window.__pollGuard = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const r = await orig(...args);
    unauthorized = r.status === 401 ? unauthorized + 1 : 0;
    return r;
  };
}

export function pollEvery(fn, ms) {
  let last = Date.now();
  const run = () => {
    last = Date.now();
    fn();
  };
  const timer = setInterval(() => {
    if (document.hidden || unauthorized >= MAX_401) return;
    run();
  }, ms);
  const onVisible = () => {
    if (document.hidden) return;
    unauthorized = 0;
    if (Date.now() - last > MIN_GAP_MS) run();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
