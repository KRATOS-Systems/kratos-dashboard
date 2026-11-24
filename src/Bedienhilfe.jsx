import React, { useEffect, useRef, useState } from "react";
import { Ico } from "./ui.jsx";

// Suche und Kurzhilfe oben auf jeder Seite (Bedienung, Stufe 2).
// - SucheKnopf sieht aus wie ein Suchfeld und öffnet die Suche (dieselbe wie Strg K); App.jsx hört auf das Ereignis "kratos-suche".
// - HilfeKnopf („?“) zeigt zwei, drei Sätze, was man auf dieser Seite tut, und führt zur ausführlichen Hilfe (Ereignis "kratos-gehe").

export function SucheKnopf() {
  return (
    <button type="button" className="suche-knopf" onClick={() => window.dispatchEvent(new Event("kratos-suche"))} title="Aufträge, Positionen, Kunden suchen (Strg K)">
      <Ico n="search" s={16} />
      <span>Suchen …</span>
      <kbd>Strg K</kbd>
    </button>
  );
}

const HILFE = {
  planung: {
    titel: "Produktionsplanung",
    saetze: [
      "Der Zeitstrahl zeigt, was auf welcher Maschine wann läuft. Balken ziehen verschiebt, ein Klick öffnet die Position.",
      "Oben in der Zeile: was heute zu tun ist, Prio-Aufträge und Kennzahlen. Ein Klick auf eine Zahl hebt die Aufträge im Zeitstrahl hervor.",
      "Neue Positionen ohne Maschine stehen unter dem Zeitstrahl. „Plan verbessern“ schlägt Platz und Reihenfolge vor.",
    ],
  },
  av: {
    titel: "Arbeitsvorbereitung",
    saetze: [
      "Je Position die sechs Punkte von Material bis EMPB. Ein Klick auf einen Status schaltet weiter: offen, in Arbeit, bereit.",
      "„Muss bis“ ist der Tag, bis zu dem alles bereit sein muss (Start auf der Maschine minus Vorlauf). Rot heißt überfällig.",
      "Ein Klick auf die Zeile öffnet Details mit Termin, Zuständigem und Notiz.",
    ],
  },
  steuerung: {
    titel: "Steuerung",
    saetze: [
      "Für die Leitung: was heute eine Entscheidung braucht, mit Freigaben und Kunden informieren.",
      "Die Reiter zeigen Versand und Rechnung, Extern und Wareneingang, Erledigtes, Datenqualität und Kennzahlen.",
      "„Datenqualität“ ist die Liste, was in Odoo oder der App fehlt oder sich widerspricht, mit Anleitung zum Beheben.",
    ],
  },
  dashboard: {
    titel: "Produktionsdashboard",
    saetze: ["Was die Maschinen gerade tun: Programm, Laufzeit heute und Auslastung.", "Die Auswertung darunter vergleicht die Wochen. Zählerstände trägt man montags ein."],
  },
  team: {
    titel: "Team",
    saetze: ["Wer heute da ist und woran gearbeitet wird.", "Abwesenheiten und Zuständigkeiten pflegst du hier."],
  },
  arbeitsplatz: {
    titel: "Mein Arbeitsplatz",
    saetze: ["Deine Aufgaben für heute, nach Reihenfolge. Oben die Prio-Aufträge der Woche.", "Anmelden mit deiner PIN. Stempeln und Fertigmelden geht direkt an der Karte."],
  },
};

export function HilfeKnopf({ thema }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const h = HILFE[thema];
  useEffect(() => {
    if (!open) return undefined;
    const out = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!h) return null;
  return (
    <span className="hilfe-knopf" ref={ref}>
      <button type="button" className="btn icon hilfe-q" aria-expanded={open} aria-label={`Hilfe zu ${h.titel}`} title="Was mache ich hier?" onClick={() => setOpen(!open)}>
        ?
      </button>
      {open && (
        <div className="hilfe-pop" role="dialog" aria-label={`Hilfe: ${h.titel}`}>
          <b>{h.titel}</b>
          {h.saetze.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
          <button
            type="button"
            className="btn quiet sm"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent("kratos-gehe", { detail: "hilfe" }));
            }}
          >
            Ausführliche Hilfe öffnen
          </button>
        </div>
      )}
    </span>
  );
}
