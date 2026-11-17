import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Kennzahlen: Hilft die KI? Liefertreue je Monat, Stunden für AV und Planung je Woche, wie viele KI-Vorschläge übernommen werden.
// Daten aus server/kennzahlen.js (Odoo-Werte eine Stunde zwischengespeichert).

const MONAT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const monat = (m) => `${MONAT[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
const ART = { av: "AV-Pakete", plan: "Planvorschläge", hinweis: "Hinweise von Talos" };
const h1 = (x) => String(Math.round(x * 10) / 10).replace(".", ",");

function Bars({ rows, value, label, max, tone, unit, sub }) {
  const top = max || Math.max(1, ...rows.map(value));
  return (
    <div className="kz-bars">
      {rows.map((r) => {
        const v = value(r);
        return (
          <div className="kz-bar" key={label(r)} title={sub ? sub(r) : undefined}>
            <span className="kz-val">{v == null ? "–" : `${h1(v)}${unit}`}</span>
            <span className="kz-col">
              <i style={{ height: `${v == null ? 0 : Math.max(2, (v / top) * 100)}%`, background: tone ? tone(r) : "var(--ink)" }} />
            </span>
            <span className="kz-lbl">{label(r)}</span>
          </div>
        );
      })}
    </div>
  );
}

const BASIS = { kalkulation: "Kalkulation", historie: "frühere Aufträge", odoo: "Odoo-Arbeitsplan", hand: "von Hand", unbekannt: "ohne Angabe (alt)" };

// Schätzgenauigkeit: gestempelte gegen geplante Stunden je Quelle (server/sollIst.js)
function SollIst({ reloadKey }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    fetch("/api/soll-ist")
      .then((r) => (r.ok ? r.json() : null))
      .then(setD)
      .catch(() => setD(null));
  }, [reloadKey]);
  if (!d) return null;
  const rows = d.stats.filter((x) => x.machine === null);
  return (
    <section>
      <h4>Schätzgenauigkeit (Soll/Ist)</h4>
      <p className="fg-faint">
        Erledigte Positionen: gestempelte Stunden (Rüsten + Fräsen) gegen die geplanten, nach Quelle. Faktor 1,2 = 20 % länger als geplant. Ab {d.minN} Vergleichen korrigiert die App Stunden aus der Kalkulation selbst.
      </p>
      {rows.length ? (
        <table className="kz-table">
          <thead>
            <tr>
              <th>Quelle</th>
              <th>Vergleiche</th>
              <th>Ist/Soll</th>
              <th>±20 %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.basis}>
                <td>{BASIS[x.basis] || x.basis}</td>
                <td>{x.n}</td>
                <td>
                  <b>{String(x.faktor).replace(".", ",")}</b>
                </td>
                <td>{x.genau} %</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="fg-faint">Noch keine erledigten Positionen mit Stempelzeiten zum Vergleichen.</div>
      )}
    </section>
  );
}

// Autopilot: Arten von Vorschlägen, die die App selbst freigeben darf (nur Leitung schaltet, nur wenn sicher genug)
function Autopilot({ reloadKey }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const load = () =>
    fetch("/api/autopilot")
      .then((r) => (r.ok ? r.json() : null))
      .then(setD)
      .catch(() => setD(null));
  useEffect(() => {
    load();
  }, [reloadKey]);
  const toggle = async (k, an) => {
    setErr("");
    const r = await fetch("/api/autopilot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kategorie: k, an }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setErr(j.error || "Hat nicht geklappt");
    load();
  };
  if (!d) return null;
  return (
    <section>
      <h4>Autopilot</h4>
      <p className="fg-faint">
        Die App gibt eine Art von Vorschlägen selbst frei, wenn die Leitung es einschaltet. Möglich erst ab {d.minN} menschlichen Entscheidungen mit mindestens {d.minQuote} % unverändert freigegeben (90 Tage). Mit Warnung nie.
      </p>
      <table className="kz-table">
        <tbody>
          {d.kategorien.map((k) => (
            <tr key={k.id}>
              <td>
                {k.label}
                <div className="fg-faint">{k.beschreibung}</div>
              </td>
              <td>{k.n ? `${k.quote} % von ${k.n}` : "–"}</td>
              <td>
                {k.an ? (
                  <button type="button" className="btn sm primary" onClick={() => toggle(k.id, false)} title={`an seit ${k.geaendert ? new Date(k.geaendert).toLocaleDateString("de-DE") : "?"}, ${k.von || ""}; ${k.automatisch} automatisch freigegeben`}>
                    an
                  </button>
                ) : (
                  <button type="button" className="btn sm" disabled={!k.moeglich} onClick={() => toggle(k.id, true)} title={k.grund || "Autopilot einschalten"}>
                    {k.moeglich ? "einschalten" : "noch nicht"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {err && <div className="fg-err">{err}</div>}
    </section>
  );
}

export default function Kennzahlen({ reloadKey }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const load = (neu) =>
    fetch("/api/kennzahlen" + (neu ? "?neu=1" : ""))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("nicht lesbar"))))
      .then(setD)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load(false);
  }, [reloadKey]);

  if (err && !d) return <div className="card kz">Kennzahlen {err}</div>;
  if (!d) return <div className="card kz fg-faint">Kennzahlen werden geladen …</div>;
  const treue = d.liefertreue || [];
  const av = d.avStunden || [];
  const avSchnitt = av.length ? av.slice(-4).reduce((s, w) => s + w.stunden, 0) / Math.min(4, av.length) : null;
  return (
    <div className="card kz">
      <div className="kz-head">
        <b>Kennzahlen</b>
        <span className="fg-faint">Stand {new Date(d.stand).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span>
        <button type="button" className="btn sm" onClick={() => load(true)}>
          Neu laden
        </button>
      </div>
      <div className="kz-grid">
        <section>
          <h4>Liefertreue</h4>
          <p className="fg-faint">
            Pünktlich geliefert zum ersten zugesagten Termin, je Monat
            {d.liefertreueQuelle === "odoo" ? " (Lieferungen laut Odoo)" : " (in der App fertig gemeldet, ohne Odoo)"}.
          </p>
          {treue.length ? (
            <Bars
              rows={treue}
              value={(m) => m.quote}
              label={(m) => monat(m.monat)}
              max={100}
              unit=" %"
              tone={(m) => (m.quote >= 90 ? "var(--ok)" : m.quote >= 75 ? "var(--warn)" : "var(--bad)")}
              sub={(m) => `${m.puenktlich} von ${m.gesamt} pünktlich, zu spät im Schnitt ${h1(m.spaetTageSchnitt)} Tage`}
            />
          ) : (
            <div className="fg-faint">Noch keine Lieferungen im Zeitraum.</div>
          )}
        </section>
        <section>
          <h4>Stunden für AV und Planung</h4>
          <p className="fg-faint">Gestempelt auf die Odoo-Aufgabe {d.avAufgabe} „AV / Planung allgemein“, je Woche. Ziel mit KI: deutlich weniger.</p>
          {av.length ? (
            <>
              <Bars rows={av} value={(w) => w.stunden} label={(w) => fmtShort(w.woche)} unit=" h" tone={() => "var(--ink)"} sub={(w) => (w.auffaellig ? `${w.auffaellig} Buchung über 12 h (Ausstempeln vergessen?)` : `Woche ab ${fmtShort(w.woche)}`)} />
              {avSchnitt != null && <div className="fg-faint">Schnitt der letzten 4 Wochen: {h1(avSchnitt)} h</div>}
            </>
          ) : (
            <div className="fg-faint">{d.avStunden === null ? "Aus Odoo gerade nicht lesbar." : "Keine Buchungen im Zeitraum."}</div>
          )}
        </section>
        <section>
          <h4>KI-Vorschläge (30 Tage)</h4>
          <p className="fg-faint">Wie oft die Vorschläge der App so übernommen werden. Hohe Quote = die KI liegt richtig.</p>
          {d.ki.length ? (
            <table className="kz-table">
              <thead>
                <tr>
                  <th />
                  <th>übernommen</th>
                  <th>abgelehnt</th>
                  <th>offen</th>
                  <th>Quote</th>
                </tr>
              </thead>
              <tbody>
                {d.ki.map((a) => (
                  <tr key={a.art}>
                    <td>{ART[a.art] || a.art}</td>
                    <td>{a.freigegeben}</td>
                    <td>{a.abgelehnt}</td>
                    <td>{a.offen}</td>
                    <td>
                      <b>{a.quote == null ? "–" : a.quote + " %"}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="fg-faint">Noch keine Vorschläge entschieden.</div>
          )}
        </section>
      </div>
      <div className="kz-grid">
        <SollIst reloadKey={reloadKey} />
        <Autopilot reloadKey={reloadKey} />
      </div>
      {d.fehler && d.fehler.length > 0 && <div className="fg-faint">Hinweis: {d.fehler.join(" · ")}</div>}
    </div>
  );
}
