import React, { useMemo, useSyncExternalStore } from "react";
import { SparkIcon } from "./ui.jsx";
import { alertsList, TSUG } from "./Overlays.jsx";
import { getDashFacts, subscribeDashFacts } from "./store.js";

// Rechte Leiste "Assistent" (nur im neuen Look, standardmäßig zu): Lagebericht und Tipps, automatisch aus den Daten der Planung
// (gleiche Quelle wie die Hinweise) und, solange das Dashboard offen ist, aus dessen Auffälligkeiten. Fragen gehen an Talos.

const plural = (n, one, many) => (n === 1 ? one : many);

export default function Assist({ shared, onClose, onOpenPosition, onAsk }) {
  const facts = useSyncExternalStore(subscribeDashFacts, getDashFacts);
  const groups = useMemo(() => (shared ? alertsList(shared) : []), [shared]);
  const [late, soon, mat] = [0, 1, 2].map((i) => (groups[i] ? groups[i].items.length : 0));

  const planText = !shared
    ? "Die Planung ist in dieser Sitzung noch nicht geöffnet. Öffne einmal die Produktionsplanung, dann stehen hier Termine und Tipps."
    : late + soon + mat === 0
      ? "In der Planung ist aktuell nichts gefährdet."
      : [
          late ? `${late} ${plural(late, "Auftrag verfehlt", "Aufträge verfehlen")} den Liefertermin` : "",
          soon ? `${soon} ${plural(soon, "Position startet", "Positionen starten")} bald ohne Vorbereitung` : "",
          mat ? `bei ${mat} ${plural(mat, "Position fehlt", "Positionen fehlt")} laut Odoo das Material` : "",
        ]
          .filter(Boolean)
          .join(", ") + ".";

  const worst = facts && facts.insights.find((i) => i.k === "bad") || (facts && facts.insights.find((i) => i.k === "warn")) || null;
  const dashText = facts ? (worst ? `${facts.week}: ${worst.t}. ${worst.d}` : `${facts.week}: Alle Maschinen liegen im Soll.`) : "";

  // Tipps: erst Auffälligkeiten aus dem Dashboard, dann die dringendsten Termine
  const tiles = [];
  if (facts) facts.insights.filter((i) => i.k !== "ok").slice(0, 3).forEach((i) => tiles.push({ tag: i.k === "bad" ? "Warnung" : "Tipp", t: i.t, d: i.d, k: i.k }));
  groups.forEach((g, gi) =>
    g.items.slice(0, gi === 0 ? 3 : 1).forEach((it) => tiles.push({ tag: gi === 0 ? "Termin" : gi === 1 ? "Start" : "Material", t: it.title, d: it.text, k: gi === 1 ? "warn" : "bad", id: it.id }))
  );

  return (
    <aside className="assist" aria-label="Assistent">
      <section className="ap-hero">
        <header>
          <span className="ap-tag">
            <SparkIcon s={14} /> Talos Assistent
          </span>
          <button type="button" className="ap-x" onClick={onClose} aria-label="Assistent schließen">
            ×
          </button>
        </header>
        <h3>Lagebericht</h3>
        <p>{planText}</p>
        {dashText && <p>{dashText}</p>}
        <h3 className="ap-sub">Live Insights</h3>
        {tiles.length ? (
          <div className="ap-tiles">
            {tiles.slice(0, 6).map((t, i) => (
              <button type="button" key={i} className={`ap-tile ${t.k}`} onClick={t.id ? () => onOpenPosition(t.id) : undefined} disabled={!t.id}>
                <small>{t.tag}</small>
                <b>{t.t}</b>
                <span>{t.d}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="ap-none">Nichts Auffälliges.</p>
        )}
      </section>

      <section className="ap-card">
        <h3>Talos fragen</h3>
        <div className="ap-chips">
          {TSUG.slice(0, 5).map((q) => (
            <button type="button" key={q} onClick={() => onAsk(q)}>
              {q}
            </button>
          ))}
        </div>
      </section>
      <p className="ap-note">Automatisch aus den Plan- und Zahlendaten, ohne Zutun.</p>
    </aside>
  );
}
