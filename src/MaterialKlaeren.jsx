import React, { useEffect, useState } from "react";
import { ODOO_URL } from "./planLogic.js";
import { Ico } from "./ui.jsx";

// „Material klären“: Fakten aus Odoo (Rohmaterial, Bestand, Bestellungen) und die drei Wege, einen Widerspruch zu lösen.
// 1. Material ist da -> in Odoo am Artikel „Bestand aktualisieren“ (Link; die App bucht selbst keinen Bestand)
// 2. Bestätigte Bestellung -> Wareneingang in Odoo öffnen und bestätigen (Link)
// 3. Fehlt doch -> in der AV den Punkt Material auf „offen“ setzen (in der App, ohne Odoo)
// Daten: GET /api/material/:id (server/materialKlaeren.js).

const ODOO = ODOO_URL.replace(/\/odoo\/.*$/, "/odoo");
const fmtN = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("de-DE");
const fmtD = (s) => (s ? s.split("-").reverse().join(".") : "");

export default function MaterialKlaeren({ orderId, avBereit, onClose, onAvReset }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stop = false;
    fetch(`/api/material/${orderId}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Odoo nicht erreichbar");
        if (!stop) setD(j);
      })
      .catch((e) => !stop && setErr(e.message));
    return () => {
      stop = true;
    };
  }, [orderId]);

  async function zuruecksetzen() {
    setBusy(true);
    const r = await fetch("/api/av", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: orderId, item: "material", status: "offen" }) }).catch(() => null);
    setBusy(false);
    if (r && r.ok) onAvReset && onAvReset();
    else setErr("AV zurücksetzen hat nicht geklappt");
  }

  return (
    <div className="matk" role="region" aria-label="Material klären">
      <div className="matk-head">
        <b>Material klären</b>
        {onClose && (
          <button type="button" className="btn icon quiet" aria-label="Schließen" onClick={onClose}>
            <Ico n="x" s={15} />
          </button>
        )}
      </div>
      {!d && !err && <div className="fg-faint">Lese Odoo …</div>}
      {err && <div className="matk-err">{err}</div>}
      {d && !d.verfuegbar && <div className="fg-faint">{d.grund}</div>}
      {d && d.verfuegbar && (
        <>
          {d.komponenten.length === 0 && <div className="fg-faint">Der Fertigungsauftrag {d.fa.name} hat in Odoo keine Komponenten.</div>}
          {d.komponenten.map((k) => {
            const offen = k.bestellungen.filter((b) => b.erhalten < b.menge);
            const we = offen.find((b) => b.wareneingang);
            return (
              <div className="matk-komp" key={k.productId}>
                <div className="matk-name">{k.name}</div>
                <div className="matk-facts">
                  <span>
                    gebraucht <b>{fmtN(k.gebraucht)}</b>
                  </span>
                  <span>
                    reserviert <b>{fmtN(k.reserviert)}</b>
                  </span>
                  <span className={k.bestand != null && k.bestand < 0 ? "neg" : ""}>
                    Bestand in Odoo <b>{k.bestand == null ? "–" : fmtN(k.bestand)}</b>
                  </span>
                </div>
                {offen.length > 0 ? (
                  <ul className="matk-po">
                    {offen.map((b) => (
                      <li key={b.id + "-" + b.name}>
                        <a href={`${ODOO}/purchase.order/${b.id}`} target="_blank" rel="noopener noreferrer">
                          {b.name}
                        </a>{" "}
                        {b.status}
                        {b.datum ? `, für ${fmtD(b.datum)}` : ""}, {fmtN(b.erhalten)} von {fmtN(b.menge)} erhalten
                        {b.entwurf ? <span className="matk-hint"> (nur Anfrage, nicht bestellt)</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="fg-faint">Keine offene Bestellung in Odoo.</div>
                )}
                <div className="matk-actions">
                  {k.productId && (
                    <a className="btn sm" href={`${ODOO}/product.product/${k.productId}`} target="_blank" rel="noopener noreferrer" title="Artikel in Odoo öffnen; dort „Bestand aktualisieren“ und die echte Menge eintragen">
                      Material ist da: Bestand in Odoo buchen <Ico n="ext" s={13} />
                    </a>
                  )}
                  {we && (
                    <a className="btn sm" href={`${ODOO}/stock.picking/${we.wareneingang.id}`} target="_blank" rel="noopener noreferrer" title="Wareneingang der Bestellung in Odoo öffnen und bestätigen">
                      Wareneingang {we.wareneingang.name} öffnen <Ico n="ext" s={13} />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          {avBereit && (
            <div className="matk-av">
              <span>Fehlt das Material doch?</span>
              <button type="button" className="btn sm" disabled={busy} onClick={zuruecksetzen}>
                In der AV auf „offen“ setzen
              </button>
            </div>
          )}
          <div className="fg-faint matk-note">Nach dem Buchen in Odoo ist der Hinweis beim nächsten Odoo-Abgleich weg (alle 10 Minuten oder „Mit Odoo abgleichen“).</div>
        </>
      )}
    </div>
  );
}
