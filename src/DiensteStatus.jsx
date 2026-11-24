import React, { useEffect, useState } from "react";

// Statuszeile „Dienste“ im Kopf der Planung: grün, wenn Odoo, Talos (Claude-Zugang) und Maschinen-Dienst laufen.
// Fällt etwas aus, wird sie gelb oder rot und nennt den Grund – damit ein Ausfall nicht tagelang unbemerkt bleibt.
// Daten: GET /api/dienste (server/dienste.js), alle 5 Minuten neu.

const FARBE = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" };

export default function DiensteStatus() {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/dienste")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => !stop && j && setD(j))
        .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (!d) return null;
  const schlecht = d.dienste.filter((x) => x.stufe !== "ok");
  const stufe = schlecht.some((x) => x.stufe === "bad") ? "bad" : schlecht.length ? "warn" : "ok";
  // Klarer Satz statt Kürzel: alles gut, oder welche Verbindung ein Problem hat (Klick zeigt Details)
  const namen = schlecht.map((x) => x.label.split(" ")[0]).join(", ");
  const text = stufe === "ok" ? "Alle Verbindungen laufen" : `${stufe === "bad" ? "Gestört" : "Bitte prüfen"}: ${namen}`;
  const tip = d.dienste.map((x) => `${x.label}: ${x.stufe === "ok" ? "läuft" : x.grund || "unbekannt"}`).join("\n");

  return (
    <span className={`dienste st-${stufe}`}>
      <button type="button" className="dienste-btn" onClick={() => setOpen(!open)} title={tip} aria-expanded={open}>
        <i style={{ background: FARBE[stufe] }} />
        {text}
      </button>
      {open && (
        <div className="dienste-pop" role="dialog" aria-label="Zustand der Dienste">
          {d.dienste.map((x) => (
            <div key={x.id} className="dienste-row">
              <i style={{ background: FARBE[x.stufe] }} />
              <b>{x.label}</b>
              <span>{x.stufe === "ok" ? "läuft" : x.grund || "Zustand unbekannt"}</span>
            </div>
          ))}
          <small>Geprüft {new Date(d.stand).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr, alle 5 Minuten neu.</small>
        </div>
      )}
    </span>
  );
}
