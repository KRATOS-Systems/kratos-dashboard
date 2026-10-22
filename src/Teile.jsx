import React, { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Ico, Thumb, partImg } from "./ui.jsx";
import { odooLink, splitProduct } from "./bdeLib.js";
import { daysBetween, fmtShort } from "./lib.js";

// Meine nächsten Teile: was als Nächstes zu tun ist, aus Planung, Arbeitsvorbereitung und Odoo.
// Je Teil: Bild, Auftrag, Artikel, meine offenen Tätigkeiten, Liefertermin, ob die Arbeitsvorbereitung bereit ist, Zeichnung.
// Darunter (falls zuständig) die offene Arbeitsvorbereitung und für die Planung die Zahl der nicht eingeplanten Positionen.

const DrawingDialog = lazy(() =>
  import("./PartDocs.jsx").then((m) => ({
    default: function DrawingDialog({ o, onClose }) {
      const { loading, files, error } = m.useFiles(o.odoo_id);
      if (loading) return <div className="kov" onClick={onClose}><div className="kbox card">Zeichnung wird aus Odoo geladen …</div></div>;
      if (error || !files.length)
        return (
          <div className="kov" onClick={onClose}>
            <div className="kbox card">{error ? `Dateien konnten nicht geladen werden: ${error}` : "Zu diesem Teil liegt in Odoo keine Zeichnung."}</div>
          </div>
        );
      return <m.FilesDialog o={o} files={files} start="pdf" onClose={onClose} />;
    },
  }))
);

function dueText(due, today) {
  if (!due) return { cls: "", text: "" };
  const d = daysBetween(today, due);
  const date = due.slice(0, 4) === today.slice(0, 4) ? fmtShort(due) : `${fmtShort(due)}${due.slice(0, 4)}`;
  return { cls: d < 0 ? "bad" : d <= 3 ? "warn" : "", text: d < 0 ? `Liefertermin ${date} überschritten` : d === 0 ? "Liefertermin heute" : `Liefertermin ${date}` };
}

export default function Teile({ viewId, today, canStart, onStart, goTo }) {
  const [data, setData] = useState(null);
  const [drawing, setDrawing] = useState(null);
  const [openInfo, setOpenInfo] = useState(null);
  const load = useCallback(() => {
    fetch(`/api/bde/teile${viewId ? `?id=${viewId}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, [viewId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60 * 1000);
    return () => clearInterval(t);
  }, [load]);
  if (!data || !data.name) return null;

  const row = (it, kind, infoFrom) => {
    const p = splitProduct(it.product);
    const due = dueText(it.due, today);
    const next = kind === "teil" && !infoFrom ? it.steps.find((st) => st.workorderId && st.state !== "blocked") || null : null;
    return (
      <div className={`card part${infoFrom ? " info" : ""}`} key={`${kind}-${it.orderId}`}>
        <Thumb src={partImg({ odoo_id: it.odooId })} size={52} />
        <div className="part-main">
          <div className="part-top">
            <b className="mono">{it.fa}</b>
            <span className="part-name">{p.name || ""}</span>
            {it.quantity != null && <span className="part-qty">{String(it.quantity).replace(".", ",")} Stk.</span>}
            {infoFrom && <span className="part-by">macht {infoFrom}</span>}
          </div>
          <div className="part-meta">
            {kind === "teil" &&
              it.steps.map((st) => (
                <span key={st.id} className={`chip${st.state === "blocked" ? " wait" : st.state === "progress" ? " run" : ""}`} title={st.state === "blocked" ? "wartet auf den Arbeitsgang davor" : ""}>
                  {st.label}
                </span>
              ))}
            {kind === "av" && it.open.map((l) => <span key={l} className="chip">{l}</span>)}
            {it.machine && <span className="part-m">{it.machine}</span>}
            {it.noMachine && <span className="part-m">noch ohne Maschine</span>}
            {kind === "av" && !it.planned && <span className="part-m">noch nicht eingeplant</span>}
            {due.text && <span className={`part-due ${due.cls}`}>{due.text}</span>}
          </div>
          {kind === "teil" && (
            <div className={`part-av ${it.avReady ? "ok" : "open"}`}>{it.avReady ? "Vorbereitung bereit" : `Vorbereitung fehlt: ${it.avOpen.join(", ")}`}</div>
          )}
          {kind === "av" && it.readyBy && <div className="part-av open">bereit sein bis {fmtShort(it.readyBy)}</div>}
        </div>
        <div className="part-act">
          {it.odooId && (
            <button type="button" className="btn sm" onClick={() => setDrawing({ odoo_id: it.odooId, order_no: it.fa, product: it.product })}>
              Zeichnung
            </button>
          )}
          {next && canStart && (
            <button type="button" className="btn sm primary" onClick={() => onStart(next)}>
              {next.label} starten
            </button>
          )}
          {it.odooId && data.odooUrl && (
            <a className="olink" href={odooLink(data.odooUrl, it.odooId)} target="_blank" rel="noreferrer" title="Fertigungsauftrag in Odoo öffnen" aria-label="Fertigungsauftrag in Odoo öffnen">
              <Ico n="ext" s={16} />
            </a>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {data.planning && data.planning.unplanned > 0 && (
        <button type="button" className="card plan-hint" onClick={() => goTo && goTo("planung")}>
          <b>{data.planning.unplanned}</b> {data.planning.unplanned === 1 ? "Position ist" : "Positionen sind"} noch nicht eingeplant
          {data.planning.ready > 0 ? `, ${data.planning.ready} davon in der Arbeitsvorbereitung bereit` : ""}
          <span className="go">Zur Planung →</span>
        </button>
      )}
      {(data.items.length > 0 || data.av.length === 0) && (
        <section className="bsec">
          <h2>Meine nächsten Teile</h2>
          {data.items.length === 0 && <div className="bnote quiet">Gerade ist nichts für dich eingeplant.</div>}
          <div className="brecent">{data.items.map((it) => row(it, "teil"))}</div>
          {data.more > 0 && <div className="part-more">und {data.more} weitere in der Planung</div>}
        </section>
      )}
      {data.av.length > 0 && (
        <section className="bsec">
          <h2>
            Arbeitsvorbereitung <span className="cntb quiet">{data.avTotal}</span>
          </h2>
          <div className="brecent">{data.av.map((it) => row(it, "av"))}</div>
          {data.avTotal > data.av.length && <div className="part-more">und {data.avTotal - data.av.length} weitere in der Arbeitsvorbereitung</div>}
        </section>
      )}
      {data.info && data.info.some((x) => x.total > 0) && (
        <section className="bsec quiet-sec">
          <h2 className="info-h">Zur Info</h2>
          {data.info
            .filter((x) => x.total > 0)
            .map((x) => {
              const key = `${x.source}|${x.scope}`;
              const open = openInfo === key;
              return (
                <div key={key} className="info-block">
                  <button type="button" className="btn quiet info-toggle" onClick={() => setOpenInfo(open ? null : key)}>
                    {x.scope === "av" ? "Arbeitsvorbereitung" : "Teile"} von {x.source}: {x.total} offen {open ? "▴" : "▾"}
                  </button>
                  {open && <div className="brecent">{x.items.map((it) => row(it, x.scope === "av" ? "av" : "teil", x.source))}</div>}
                </div>
              );
            })}
        </section>
      )}
      {drawing && (
        <Suspense fallback={null}>
          <DrawingDialog o={drawing} onClose={() => setDrawing(null)} />
        </Suspense>
      )}
    </>
  );
}
