import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";
import { Ico } from "./ui.jsx";

// Handy-Ansicht „Unterwegs“: nur lesen, was heute brennt. Erscheint auf schmalen Bildschirmen statt Planung und Steuerung
// (App.jsx), mit Knopf zur vollen Ansicht. Daten: GET /api/heute?bereich=steuerung (server/heute.js) und GET /api/prio.

const TON = { bad: "var(--bad)", warn: "var(--warn)", mute: "var(--faint)" };

export default function Unterwegs({ onVoll }) {
  const [heute, setHeute] = useState(null);
  const [prio, setPrio] = useState(null);
  const [stand, setStand] = useState(null);
  const [info, setInfo] = useState(false);
  const laden = () => {
    fetch("/api/heute?bereich=steuerung")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setHeute(j.items || []))
      .catch(() => {});
    fetch("/api/prio")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setPrio(j.items || []))
      .catch(() => {});
    setStand(new Date());
  };
  useEffect(() => {
    laden();
    const t = setInterval(laden, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const d = new Date();
  const tag = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit" });
  const wichtig = (heute || []).filter((i) => i.tone !== "mute");
  const rest = (heute || []).filter((i) => i.tone === "mute");
  return (
    <div className="uw">
      <div className="uw-head">
        <div>
          <h1>Heute</h1>
          <p>
            {tag}
            {stand ? ` · Stand ${stand.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr` : ""}
          </p>
        </div>
        <button type="button" className="btn sm" onClick={laden} aria-label="Neu laden">
          <Ico n="refresh" s={15} />
        </button>
      </div>

      <section className="uw-card">
        <h2>{heute == null ? "Was heute ansteht" : wichtig.length ? `${wichtig.length} ${wichtig.length === 1 ? "Punkt braucht" : "Punkte brauchen"} dich` : "Alles erledigt ✓"}</h2>
        {heute == null && <p className="fg-faint">Wird geladen …</p>}
        {wichtig.map((i) => (
          <div className="uw-row" key={i.id}>
            <i style={{ background: TON[i.tone] }} />
            <b>{i.n}</b>
            <span>
              {i.text.replace(/^\d+\s/, "")}
              {i.hint && <small>{i.hint}</small>}
            </span>
          </div>
        ))}
        {rest.length > 0 && (
          <button type="button" className="btn quiet sm" onClick={() => setInfo(!info)}>
            {info ? "Hinweise ausblenden" : `+ ${rest.length} ${rest.length === 1 ? "Hinweis" : "Hinweise"}`}
          </button>
        )}
        {info &&
          rest.map((i) => (
            <div className="uw-row mute" key={i.id}>
              <i style={{ background: TON.mute }} />
              <b>{i.n}</b>
              <span>{i.text.replace(/^\d+\s/, "")}</span>
            </div>
          ))}
      </section>

      {prio && prio.length > 0 && (
        <section className="uw-card">
          <h2>Prio diese Woche</h2>
          {prio.map((p) => (
            <div className="uw-row" key={p.auftrag}>
              <i style={{ background: "var(--bad)" }} />
              <b className="uw-auf">{p.label}</b>
              <span>
                {[p.kunde, p.termin ? `Termin ${fmtShort(p.termin)}` : null].filter(Boolean).join(" · ")}
                <small>
                  {p.positionen.length} {p.positionen.length === 1 ? "Position" : "Positionen"}
                  {p.positionen.some((x) => x.avOffen && x.avOffen.length) ? " · AV noch offen" : ""}
                </small>
              </span>
            </div>
          ))}
        </section>
      )}

      <button type="button" className="btn uw-voll" onClick={onVoll}>
        Volle Ansicht öffnen (Zeitstrahl, Bearbeiten)
      </button>
    </div>
  );
}
