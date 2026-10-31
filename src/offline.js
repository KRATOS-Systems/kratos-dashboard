// Erkennt, ob die App gerade den gemerkten Stand zeigt, weil der Server nicht erreichbar ist (siehe public/sw.js).
// Antworten aus dem Gerätespeicher tragen den Kopf x-offline-stand; scheitert eine Abfrage ganz, ist der Server nicht erreichbar.
// Sobald eine Abfrage wieder normal beantwortet wird, ist der Hinweis weg.

import { useEffect, useState } from "react";

let state = { offline: false, at: null };
const listeners = new Set();
const set = (next) => {
  if (next.offline === state.offline && next.at === state.at) return;
  state = next;
  listeners.forEach((l) => l(state));
};
const isApi = (input) => {
  try {
    const u = typeof input === "string" ? input : input && input.url;
    return !!u && new URL(u, window.location.href).pathname.startsWith("/api/");
  } catch {
    return false;
  }
};

if (typeof window !== "undefined" && typeof window.fetch === "function" && !window.__offlineGuard) {
  window.__offlineGuard = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (...args) => {
    try {
      const r = await orig(...args);
      const at = r.headers.get("x-offline-stand");
      if (at) set({ offline: true, at });
      else if (r.ok && isApi(args[0])) set({ offline: false, at: null });
      return r;
    } catch (err) {
      if (isApi(args[0])) set({ offline: true, at: state.at });
      throw err;
    }
  };
}

export function useOffline() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => listeners.delete(setS);
  }, []);
  return s;
}

export function registerOffline() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* ohne Offline-Stand läuft die App wie bisher */
    });
  });
}
