import React, { useEffect, useState } from "react";
import { ODOO_URL } from "./planLogic.js";
import MaterialKlaeren from "./MaterialKlaeren.jsx";

// Datenqualität: was in Odoo, Kalkulation oder App fehlt und die KI ausbremst, als Arbeitsliste mit Links (server/datenqualitaet.js).

export default function Datenqualitaet({ reloadKey, onCount }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const [kl, setKl] = useState(null); // Position, deren „Material klären“ offen ist
  const [reload, setReload] = useState(0);
  useEffect(() => {
    fetch("/api/datenqualitaet")
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "nicht lesbar");
        setD(j);
        onCount && onCount(j.gesamt);
      })
      .catch((e) => setErr(e.message));
  }, [reloadKey, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !d) return <div className="card dq fg-faint">Datenqualität: {err}</div>;
  if (!d) return <div className="card dq fg-faint">Datenqualität wird geladen …</div>;
  const offen = d.gruppen.filter((g) => g.n > 0);
  return (
    <div className="card dq">
      <div className="kz-head">
        <b>Datenqualität</b>
        <span className="fg-faint">Was die KI ausbremst. Jeder erledigte Punkt macht Vorschläge genauer.</span>
      </div>
      {!offen.length && <div className="ak-ok">Alles sauber ✓</div>}
      <div className="dq-list">
        {d.gruppen.map((g) => (
          <div key={g.id} className={`dq-group${g.n ? "" : " ok"}`}>
            <button type="button" className="dq-head" onClick={() => setOpen(open === g.id ? null : g.id)} disabled={!g.n} aria-expanded={open === g.id}>
              <b className="dq-n">{g.n}</b>
              <span>
                <b>{g.titel}</b>
                <small>{g.wie}</small>
              </span>
              <span className="ak-go">{g.n ? (open === g.id ? "▾" : "▸") : "✓"}</span>
            </button>
            {open === g.id && (
              <ul className="dq-items">
                {g.items.map((x, i) => (
                  <li key={x.ref + i}>
                    {x.link ? (
                      <a href={`${ODOO_URL.replace(/\/odoo\/.*$/, "")}${x.link}`} target="_blank" rel="noopener noreferrer" title="In Odoo öffnen">
                        {x.ref}
                      </a>
                    ) : x.odooId ? (
                      <a href={`${ODOO_URL}/${x.odooId}`} target="_blank" rel="noopener noreferrer">
                        {x.ref}
                      </a>
                    ) : (
                      <b>{x.ref}</b>
                    )}
                    <span className="fg-faint">
                      {[x.source, x.customer, x.product, x.grund].filter(Boolean).join(" · ")}
                    </span>
                    {x.klaeren === "material" && x.orderId && (
                      <button type="button" className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setKl(kl === x.orderId ? null : x.orderId)} aria-expanded={kl === x.orderId}>
                        Klären
                      </button>
                    )}
                    {kl === x.orderId && x.klaeren === "material" && (
                      <div style={{ flexBasis: "100%" }}>
                        <MaterialKlaeren orderId={x.orderId} avBereit onClose={() => setKl(null)} onAvReset={() => { setKl(null); setReload((v) => v + 1); }} />
                      </div>
                    )}
                  </li>
                ))}
                {g.n > g.items.length && <li className="fg-faint">… und {g.n - g.items.length} weitere</li>}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
