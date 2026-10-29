import React, { useCallback, useEffect, useState } from "react";

const eur = (v) => (typeof v === "number" ? v.toLocaleString("de-DE", { style: "currency", currency: "EUR" }) : "");

// Mein Arbeitsplatz (nur Leitung): Kundenaufträge, die komplett gefertigt sind und bei denen Odoo noch etwas zu berechnen sieht.
// Die App liefert und berechnet nichts, sie zeigt es nur an; ist alles berechnet, verschwindet der Eintrag.
export default function RechnungBereit({ odooUrl }) {
  const [items, setItems] = useState([]);
  const load = useCallback(() => {
    fetch("/api/bde/rechnung")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("bde-changed", load);
    return () => window.removeEventListener("bde-changed", load);
  }, [load]);
  if (!items.length) return null;
  return (
    <section className="bsec lzoffen">
      <h2>
        Zur Rechnung bereit <span className="cntb">{items.length}</span>
      </h2>
      <p className="bsub">Alle Teile gefertigt. In Odoo ist noch etwas zu berechnen.</p>
      <div className="brecent">
        {items.map((i) => (
          <div className="card brow" key={i.id}>
            <b className="mono">{i.name}</b>
            <span className="t">{i.partner}</span>
            <span className="when">
              {[`${i.parts} ${i.parts === 1 ? "Teil" : "Teile"} fertig`, i.deliveryLabel, eur(i.total), i.invoices ? `${i.invoices} Rechnung${i.invoices === 1 ? "" : "en"} bisher` : "noch keine Rechnung"].filter(Boolean).join(" · ")}
            </span>
            {odooUrl && (
              <a className="btn sm" href={`${odooUrl}/odoo/sale.order/${i.id}`} target="_blank" rel="noopener noreferrer">
                In Odoo öffnen
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
