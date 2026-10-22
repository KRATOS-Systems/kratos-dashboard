import React, { useCallback, useEffect, useState } from "react";
import { Ico, useToast } from "./ui.jsx";
import { daysBetween } from "./lib.js";

// Meine Aufgaben: offene Odoo-Aktivitäten des Mitarbeiters, nach Frist sortiert.
// Farbe statt Text: rot = überfällig, gelb = heute, ohne Farbe = später.
// "Erledigt" (nur mit BDE_WRITE, nur eigene) schließt die Aktivität in Odoo; "Stempeln" springt bei Fertigungsaufträgen in die Auswahl.

const SHOW = 5;
// Belegnummern (FA01307, A01365, P00077, WH/OUT/00012) in Schreibmaschinenschrift, Namen normal
const NUMBERED = new Set(["mrp.production", "sale.order", "purchase.order", "stock.picking", "account.move"]);
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function due(deadline, today) {
  if (!deadline) return { cls: "later", text: "ohne Frist" };
  const d = daysBetween(today, deadline);
  if (d < 0) return { cls: "over", text: d === -1 ? "seit gestern fällig" : `seit ${-d} Tagen fällig` };
  if (d === 0) return { cls: "today", text: "heute" };
  if (d === 1) return { cls: "later", text: "morgen" };
  const dt = new Date(`${deadline}T12:00:00Z`);
  return { cls: "later", text: `${WD[dt.getUTCDay()]} ${deadline.slice(8, 10)}.${deadline.slice(5, 7)}.` };
}

export default function Aufgaben({ viewId, canStamp, onStamp }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/bde/aufgaben${viewId ? `?id=${viewId}` : ""}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Aufgaben nicht verfügbar");
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [viewId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60 * 1000);
    return () => clearInterval(t);
  }, [load]);

  async function done(a) {
    setBusy(true);
    try {
      const r = await fetch("/api/bde/aufgaben/erledigt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Das hat nicht geklappt");
      toast(`Erledigt: ${a.summary || a.type}`);
      setConfirm(null);
      load();
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (err) return null;
  if (!data) return null;
  const items = data.items;
  const overdue = items.filter((a) => a.deadline && a.deadline < data.today).length;
  const shown = all ? items : items.slice(0, SHOW);

  return (
    <section className="bsec">
      <h2>
        {data.own === false ? "Aufgaben" : "Meine Aufgaben"}
        {items.length > 0 && <span className={`cntb${overdue ? "" : " quiet"}`}>{items.length}</span>}
      </h2>
      {data.noUser && <div className="bnote quiet">Ohne Odoo-Benutzer gibt es keine Aufgaben. Aktivitäten werden in Odoo Benutzern zugewiesen.</div>}
      {!data.noUser && items.length === 0 && <div className="bnote quiet">Keine offenen Aufgaben.</div>}
      <div className="brecent">
        {shown.map((a) => {
          const u = due(a.deadline, data.today);
          return (
            <div key={a.id} className={`card task due-${u.cls}`}>
              <div className="task-main">
                <div className="task-top">
                  {a.summary && <span className="task-type">{a.type}</span>}
                  <b className="task-sum">{a.summary || a.type}</b>
                </div>
                <div className="task-meta">
                  {a.resName && (
                    <span className="task-res">
                      {a.modelLabel ? `${a.modelLabel} ` : ""}
                      <b className={NUMBERED.has(a.model) ? "mono" : undefined}>{a.resName}</b>
                    </span>
                  )}
                  <span className="task-due">{u.text}</span>
                </div>
                {a.note && <div className="task-note">{a.note}</div>}
              </div>
              <div className="task-act">
                {canStamp && a.model === "mrp.production" && a.resName && (
                  <button type="button" className="btn sm" onClick={() => onStamp(a.resName)}>
                    Stempeln
                  </button>
                )}
                {data.canDone &&
                  (confirm === a.id ? (
                    <>
                      <button type="button" className="btn sm ok" disabled={busy} onClick={() => done(a)}>
                        Ja, erledigt
                      </button>
                      <button type="button" className="btn sm" onClick={() => setConfirm(null)}>
                        Nein
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn sm" onClick={() => setConfirm(a.id)}>
                      <Ico n="check" s={15} />
                      Erledigt
                    </button>
                  ))}
                {a.link && (
                  <a className="olink" href={a.link} target="_blank" rel="noreferrer" title="In Odoo öffnen" aria-label="In Odoo öffnen">
                    <Ico n="ext" s={16} />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {items.length > SHOW && (
        <button type="button" className="btn quiet task-more" onClick={() => setAll((v) => !v)}>
          {all ? "Weniger anzeigen" : `Alle ${items.length} anzeigen`}
        </button>
      )}
    </section>
  );
}

