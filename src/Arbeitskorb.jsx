import React, { useEffect, useState } from "react";
import Freigaben from "./Freigaben.jsx";
import Fruehwarnung from "./Fruehwarnung.jsx";

// Arbeitskorb: ein Kasten oben auf der Planung statt vieler. Alles, was heute eine Entscheidung braucht, nach Dringlichkeit
// (rot = heute handeln, gelb = diese Woche, grau = Info). Freigaben und Kunden informieren klappen direkt hier auf, der Rest springt
// an die Stelle, wo man es erledigt. Ist nichts zu tun, bleibt eine Zeile "Alles erledigt".
// Daten: GET /api/heute (server/heute.js).

const TONE = { bad: "var(--bad)", warn: "var(--warn)", mute: "var(--faint)" };
const INLINE = { freigaben: "freigaben", kunden: "kunden" };

export default function Arbeitskorb({ reloadKey, onJump, onChanged, onHighlight, onCounts, bereich = "steuerung" }) {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null); // aufgeklappte Zeile
  const [mute, setMute] = useState(false); // graue Hinweise zeigen

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/heute?bereich=" + bereich)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (stop || !j) return;
          setD(j);
          onCounts && onCounts(j.items);
        })
        .catch(() => {});
    const t = setTimeout(load, d ? 1200 : 0);
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => {
      stop = true;
      clearTimeout(t);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  if (!d) return null;
  const wichtig = d.items.filter((i) => i.tone !== "mute");
  const info = d.items.filter((i) => i.tone === "mute");
  const rot = wichtig.filter((i) => i.tone === "bad").length;
  const changed = () => {
    onChanged && onChanged();
  };

  const row = (i) => {
    const inline = INLINE[i.id];
    const isOpen = open === i.id;
    const click = () => (inline ? setOpen(isOpen ? null : i.id) : onJump && onJump(i.ziel, i.id));
    return (
      <div key={i.id} className={`ak-row ${i.tone}${isOpen ? " open" : ""}`}>
        <button type="button" className="ak-head" onClick={click} aria-expanded={inline ? isOpen : undefined} title={inline ? "Hier aufklappen" : "Dorthin springen"}>
          <i className="dot" style={{ "--c": TONE[i.tone] }} />
          <b className="ak-n">{i.n}</b>
          <span className="ak-t">
            {i.text.replace(/^\d+\s/, "")}
            {i.hint && <small>{i.hint}</small>}
          </span>
          <span className="ak-go">{inline ? (isOpen ? "▾" : "▸") : "›"}</span>
        </button>
        {isOpen && i.id === "freigaben" && (
          <div className="ak-body">
            <Freigaben embedded reloadKey={reloadKey} onChanged={changed} onHighlight={onHighlight} />
          </div>
        )}
        {isOpen && i.id === "kunden" && (
          <div className="ak-body">
            <Fruehwarnung embedded reloadKey={reloadKey} onChanged={changed} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div id="arbeitskorb" className={`arbeitskorb card rise${rot ? " bad" : ""}`} style={{ "--i": 1 }}>
      <div className="ak-top">
        <b>{bereich === "steuerung" ? "Heute entscheiden" : "Heute"}</b>
        {wichtig.length ? (
          <span className="ak-sum">
            {rot > 0 && <span className="ak-pill bad">{rot} heute handeln</span>}
            {wichtig.length - rot > 0 && <span className="ak-pill warn">{wichtig.length - rot} diese Woche</span>}
          </span>
        ) : (
          <span className="ak-ok">{bereich === "steuerung" ? "Alles erledigt ✓ Nichts zu entscheiden." : "Alles erledigt ✓ Planung und Arbeitsvorbereitung sind auf Stand."}</span>
        )}
        {info.length > 0 && (
          <button type="button" className="ak-info" onClick={() => setMute((v) => !v)}>
            {mute ? "Hinweise ausblenden" : `+ ${info.length} ${info.length === 1 ? "Hinweis" : "Hinweise"}`}
          </button>
        )}
      </div>
      {(wichtig.length > 0 || mute) && <div className="ak-list">{[...wichtig, ...(mute ? info : [])].map(row)}</div>}
    </div>
  );
}
