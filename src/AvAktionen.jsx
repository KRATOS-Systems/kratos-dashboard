import React, { useEffect, useState } from "react";
import { Ico } from "./ui.jsx";

// Ein-Klick-Aktionen der Arbeitsvorbereitung in Odoo (server/avAktionen.js):
//   Zeiten aus der Kalkulation übernehmen · Material nach AV001 anlegen und eintragen · Fertigungsauftrag bestätigen · im Materialportal bestellen.
// Jede Zeile zeigt, was der Klick macht; ohne Klick ändert sich nichts. Schreiben nur mit PIN-Anmeldung.

const fmt = (n) => (n == null ? "–" : String(Math.round(Number(n) * 10) / 10).replace(".", ","));

export default function AvAktionen({ orderId, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [form, setForm] = useState(null);
  const [done, setDone] = useState([]);
  const [n, setN] = useState(0);

  useEffect(() => {
    let stop = false;
    setErr(null);
    fetch(`/api/av/aktionen/${orderId}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (stop) return;
        if (!r.ok) setErr(j.error || "Nicht lesbar");
        else {
          setD(j);
          if (j.material && j.material.vorschlag) setForm((f) => f || j.material.vorschlag);
        }
      })
      .catch(() => !stop && setErr("Nicht erreichbar"));
    return () => {
      stop = true;
    };
  }, [orderId, n]);

  const run = async (what, body) => {
    setBusy(what);
    setErr(null);
    try {
      const r = await fetch(`/api/av/aktionen/${orderId}/${what}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Nicht gespeichert");
      setDone((x) => [...x, ...(j.erledigt || [])]);
      setN((x) => x + 1);
      onChanged && onChanged();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (!d && !err) return <div className="ava card-sub">AV-Aktionen werden geladen …</div>;
  if (d && !d.verfuegbar) return null;
  const z = d && d.zeiten;
  const m = d && d.material;
  const opt = m && m.optionen ? m.optionen.find((x) => x.form === form) || m.optionen[0] : null;
  const zeitenAnders = z && z.moeglich && (z.odoo.ruesten !== z.neu.ruesten || Math.abs((z.odoo.fraesen || 0) - z.neu.fraesen) > 0.5 || (z.neu.programmieren > 0 && z.odoo.programmieren !== z.neu.programmieren) || z.muster);

  return (
    <div className="ava">
      <div className="ava-head">
        <b>In Odoo erledigen</b>
        <small>Ein Klick schreibt nach Odoo. Ohne Klick ändert sich nichts.</small>
      </div>
      {err && <div className="ava-err">{err}</div>}
      {d && (
        <div className="ava-list">
          {/* 1. Zeiten */}
          <div className={`ava-row${zeitenAnders ? "" : " ok"}`}>
            <span className="ava-n">1</span>
            <div className="ava-t">
              <b>Zeiten aus der Kalkulation</b>
              {z && z.moeglich ? (
                <small>
                  Programmieren {fmt(z.neu.programmieren)} min · Rüsten {fmt(z.neu.ruesten)} min · Fräsen {fmt(z.kalk.fraesenJeStk)} min/Stk = {fmt(z.neu.fraesen)} min → {fmt(z.stunden)} h in der Planung
                  {" · "}Odoo bisher: Rüsten {fmt(z.odoo.ruesten)}, Fräsen {fmt(z.odoo.fraesen)} min{z.muster ? " (Musterwerte)" : ""}
                  {z.stueckliste ? "" : " · Stückliste bleibt (gemeinsam genutzt oder aufgeteilt)"}
                </small>
              ) : (
                <small>{z ? z.grund : "–"}</small>
              )}
            </div>
            {z && z.moeglich && (zeitenAnders ? (
              <button type="button" className="btn sm primary" disabled={!!busy || !d.schreiben} onClick={() => run("zeiten")} title="Schreibt die Zeiten in die Arbeitsgänge des Fertigungsauftrags und in die Stückliste, entfernt MUSTER und setzt die Stunden in der Planung">
                {busy === "zeiten" ? "Übernehme …" : "Übernehmen"}
              </button>
            ) : (
              <span className="ava-ok">✓ passt</span>
            ))}
          </div>

          {/* 2. Material */}
          <div className={`ava-row${m && m.fehlt ? "" : " ok"}`}>
            <span className="ava-n">2</span>
            <div className="ava-t">
              <b>Material</b>
              {m && !m.fehlt && <small>In Odoo eingetragen: {m.komponenten.join(", ")}</small>}
              {m && m.fehlt && !m.moeglich && <small>Fehlt im Fertigungsauftrag. {m.grund}</small>}
              {m && m.fehlt && m.moeglich && (
                <>
                  <small>
                    Fehlt im Fertigungsauftrag. Vorschlag nach AV001 aus der Kalkulation (Rohteil {m.rohteil}), Lieferant {m.lieferant}:
                  </small>
                  <div className="ava-forms" role="radiogroup" aria-label="Form des Rohmaterials">
                    {m.optionen.map((x) => (
                      <label key={x.form} className={`ava-form${form === x.form ? " on" : ""}`}>
                        <input type="radio" name={`form-${orderId}`} checked={form === x.form} onChange={() => setForm(x.form)} />
                        <b>{x.name}</b>
                        <small>
                          {x.art === "stange" ? `Stangenware, ${fmt(x.menge)} mm je Teil` : "Zuschnitt, 1 Stk je Teil"}
                          {x.vorhanden ? " · Artikel gibt es schon" : " · wird angelegt"}
                          {x.form === m.vorschlag ? " · Vorschlag" : ""}
                        </small>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
            {m && m.fehlt && m.moeglich && opt && (
              <button type="button" className="btn sm primary" disabled={!!busy || !d.schreiben} onClick={() => run("material", { form: opt.form })} title="Sucht den Artikel oder legt ihn nach AV001 an (Lieferant, Routen, Chargen) und trägt ihn in Stückliste und Fertigungsauftrag ein">
                {busy === "material" ? "Lege an …" : opt.vorhanden ? "Eintragen" : "Anlegen und eintragen"}
              </button>
            )}
            {m && !m.fehlt && <span className="ava-ok">✓</span>}
          </div>

          {/* 3. FA bestätigen */}
          <div className={`ava-row${d.fa.entwurf ? "" : " ok"}`}>
            <span className="ava-n">3</span>
            <div className="ava-t">
              <b>Fertigungsauftrag {d.fa.name}</b>
              <small>{d.fa.entwurf ? "Noch im Entwurf. Bestätigen legt in Odoo die Anfrage für das Material an (AV001 5.7)." : "Bestätigt."}</small>
            </div>
            {d.fa.entwurf ? (
              <button type="button" className="btn sm primary" disabled={!!busy || !d.schreiben || (m && m.fehlt)} onClick={() => run("bestaetigen")} title={m && m.fehlt ? "Erst das Material eintragen, sonst entsteht keine Anfrage" : "Fertigungsauftrag in Odoo bestätigen"}>
                {busy === "bestaetigen" ? "Bestätige …" : "Bestätigen"}
              </button>
            ) : (
              <span className="ava-ok">✓</span>
            )}
          </div>

          {/* 4. Bestellen */}
          <div className="ava-row">
            <span className="ava-n">4</span>
            <div className="ava-t">
              <b>Material bestellen</b>
              <small>Im Materialportal unter „Aus Odoo bestellen“ Preise vergleichen, übernehmen und in Odoo bestätigen.</small>
            </div>
            <a className="btn sm" href={d.portal} target="portal" rel="noopener">
              Materialportal <Ico n="ext" s={14} />
            </a>
          </div>
        </div>
      )}
      {d && !d.schreiben && <div className="ava-err">Schreiben in Odoo ist nicht freigeschaltet (BDE_WRITE).</div>}
      {done.length > 0 && (
        <ul className="ava-done">
          {done.map((t, i) => (
            <li key={i}>✓ {t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
