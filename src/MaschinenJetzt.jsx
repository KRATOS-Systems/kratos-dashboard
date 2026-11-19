import React, { useState } from "react";
import { MACHINES } from "./lib.js";
import { MTile } from "./ui.jsx";
import { useAmpel, AmpelDialog, TEXT } from "./Ampel.jsx";
import { useNow } from "./bdeLib.js";

// Maschinen jetzt: eine Karte je Maschine mit dem, was die Steuerung gerade meldet (Daten: /api/maschinen/ampel,
// Live-Teil aus dem Maschinen-Dienst über server/maschinenLive.js). Ohne Live-Daten zeigt die Karte nur die Stempel.
// Ein Klick öffnet den Ampel-Dialog (Details, Lauf beenden).

const TON = { lauf: "ok", ruesten: "warn", pause: "warn", stoerung: "bad", steht: "bad", frei: "mute" };
const SPINDEL = { rechts: "dreht", links: "dreht links", aus: "steht" };
const BETRIEB = { AUTOMATIC: "Automatik", SINGLE_STEP: "Einzelsatz", MANUAL: "Hand", MDI: "MDI", HANDWHEEL: "Handrad", MDA: "MDA", JOG: "Jog" };

const uhr = (iso) => (iso && iso.length >= 16 ? iso.slice(11, 16) : "");
const dauer = (min) => {
  if (min == null) return "–";
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
};
// Ortszeit des Dienst-PCs ohne Zone: wie Europe/Berlin behandeln, für Minutenabstände reicht der Browser
const minSeit = (iso, now) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60000) : null;
};
const zahl = (v, d = 1) => (v == null ? "–" : v.toLocaleString("de-DE", { maximumFractionDigits: d }));

function Rest({ r }) {
  const pct = Math.max(0, Math.min(100, r.prozent || 0));
  const restMin = r.restS != null ? r.restS / 60 : null;
  return (
    <div className={`mj-rest${r.ueberzogen ? " over" : ""}`}>
      <div className="mj-rest-top">
        <span>
          <small>Fertig ca.</small>
          <b>{r.ueberzogen ? "überfällig" : `${uhr(r.fertigUm)} Uhr`}</b>
        </span>
        <span className="mj-rest-right">
          <b>{r.ueberzogen ? `+${dauer(-restMin)}` : `noch ${dauer(restMin)}`}</b>
          <small>
            üblich {dauer(r.erwartetS / 60)} (aus {r.laeufe} {r.laeufe === 1 ? "Lauf" : "Läufen"})
          </small>
        </span>
      </div>
      <div className="mj-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Karte({ mm, m, onOpen, now }) {
  const l = m.quelle === "maschine" ? m.live : null;
  const roh = m.live || null; // auch ohne Programmzustand (POS) kommen Spindel und Tageszahlen
  const lauf = m.runs.find((r) => r.step === "Fräsen") || m.runs[0];
  const seit = l ? minSeit(l.seit, now) : null;
  const wz = l && l.werkzeug != null ? l : null;
  const sz = l && l.werkzeugInfo && l.werkzeugInfo.standzeitProzent;
  return (
    <button type="button" className={`card mj-card mj-${TON[m.state] || "mute"}`} onClick={onOpen} title="Details und Lauf beenden">
      <header>
        <MTile c={mm.c} img={mm.img} imgZoom={mm.imgZoom} />
        <span className="mj-name">
          {mm.short}
          {l && <span className="amp-live" title="Live von der Steuerung" />}
          <small>{seit != null ? `seit ${dauer(seit)}` : m.quelle === "maschine" ? "" : "nur Stempel"}</small>
        </span>
        <span className={`pill mj-state ${TON[m.state] || ""}`}>{TEXT[m.state] || m.state}</span>
      </header>

      <div className="mj-prog">
        <b className="mono">{(l && l.programm) || (lauf && lauf.fa) || "kein Programm"}</b>
        <small>
          {[
            l && l.unterprogramm ? `ruft ${l.unterprogramm}` : null,
            l && l.zeile ? `Satz ${l.zeile.toLocaleString("de-DE")}` : null,
            l && l.betriebsart && l.betriebsart !== "UNDEFINED" ? BETRIEB[l.betriebsart] || l.betriebsart : null,
            !l && roh && roh.zustand === "keine_daten" ? "Steuerung gibt den Programmzustand nicht frei" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
        {lauf && (
          <small className="mj-fa">
            {lauf.step} {lauf.fa || ""}
            {lauf.who ? ` · ${lauf.who}` : ""}
          </small>
        )}
      </div>

      {l && l.restzeit && ["lauf", "pause"].includes(m.state) && <Rest r={l.restzeit} />}

      {wz && (
        <div className="mj-wz">
          <div>
            <b>T{wz.werkzeug}</b> {wz.werkzeugname || ""}
            {wz.werkzeugInfo && wz.werkzeugInfo.gesperrt && <span className="pill bad">gesperrt</span>}
          </div>
          {wz.werkzeugInfo && (
            <small>
              {[wz.werkzeugInfo.r != null ? `R ${zahl(wz.werkzeugInfo.r, 2)}` : null, wz.werkzeugInfo.einsatzH != null ? `im Einsatz gesamt ${zahl(wz.werkzeugInfo.einsatzH)} h` : null]
                .filter(Boolean)
                .join(" · ")}
            </small>
          )}
          {sz != null && (
            <div className={`mj-bar thin${sz >= 90 ? " bad" : sz >= 80 ? " warn" : ""}`} title={`Standzeit ${zahl(sz, 0)} % verbraucht`}>
              <i style={{ width: `${Math.min(100, sz)}%` }} />
            </div>
          )}
        </div>
      )}

      {roh && (
        <div className="mj-chips">
          {roh.spindel && (
            <span>
              Spindel <b>{SPINDEL[roh.spindel]}</b>
            </span>
          )}
          {l && l.vorschub != null && (
            <span className={l.vorschub < 100 ? "warn" : ""}>
              Vorschub <b>{Math.round(l.vorschub)} %</b>
            </span>
          )}
          {l && l.drehzahl != null && (
            <span className={l.drehzahl < 100 ? "warn" : ""}>
              Drehzahl <b>{Math.round(l.drehzahl)} %</b>
            </span>
          )}
          {l && l.zaehler && l.zaehler.teileGesamt != null && (
            <span>
              Teile <b>{zahl(l.zaehler.teile, 0)}</b> ({zahl(l.zaehler.teileGesamt, 0)})
            </span>
          )}
        </div>
      )}

      {l && l.fehler.length > 0 && <div className="mj-box bad">{l.fehler.join(" · ")}</div>}
      {l && l.hinweise.length > 0 && <div className="mj-box warn">{l.hinweise.join(" · ")}</div>}
      {m.hinweis && <div className="mj-box warn">{m.hinweis}</div>}

      <footer className="mj-heute">
        <div>
          Läufe heute<b>{roh && roh.heute ? zahl(roh.heute.laeufe, 0) : "–"}</b>
        </div>
        <div>
          Laufzeit heute<b>{roh && roh.heute ? dauer(roh.heute.laufzeitMin) : "–"}</b>
        </div>
        <div title="Anteil „läuft“ an der Zeit, in der die Maschine erreichbar war">
          Auslastung<b>{roh && roh.heute && roh.heute.auslastung != null ? `${zahl(roh.heute.auslastung, 0)} %` : "–"}</b>
        </div>
      </footer>
    </button>
  );
}

export default function MaschinenJetzt() {
  const d = useAmpel();
  const now = useNow(30000);
  const [open, setOpen] = useState(null);
  if (!d || !d.machines) return null;
  return (
    <section className="mj rise" style={{ "--i": 1 }} aria-label="Maschinen jetzt">
      <div className="mj-head">
        <h2>Maschinen jetzt</h2>
        <small>{d.live ? "live von den Steuerungen, alle 20 Sekunden" : "keine Live-Daten vom Maschinen-Dienst, nur Stempel"}</small>
      </div>
      <div className="mcards">
        {MACHINES.map((mm) => {
          const m = d.machines[mm.id];
          return m ? <Karte key={mm.id} mm={mm} m={m} now={now} onOpen={() => setOpen(mm.id)} /> : null;
        })}
      </div>
      {open && <AmpelDialog machine={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
