import React, { useEffect, useMemo, useState } from "react";
import { fmtShort, fmtH } from "./lib.js";
import { posNo, ODOO_SALE_URL } from "./planLogic.js";
import { Ico } from "./ui.jsx";

// Reiter „Versand“: was nach QS / Extern versandbereit ist, und was versendet, aber noch nicht berechnet ist.
// Versendet ist eine Position, sobald die Lieferung in Odoo bestätigt ist (server/versand.js). Rechnungen schreibt die App nicht;
// für jeden neuen Lieferstand legt sie in Odoo eine Aufgabe „Rechnung stellen“ an.

const day = (s) => (s ? fmtShort(s) : "–");
const eur = (n) => (n || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const fmtN = (n) => (Math.round(n * 100) / 100).toLocaleString("de-DE");

const ZIEL = { qs: "QS (Wareneingangsprüfung)", versand: "Versand" };

// Automatik: wohin eine Position nach dem Wareneingang geht, und was zuletzt automatisch weiterging (server/automatik.js)
function Automatik({ reloadKey, onOpen }) {
  const [a, setA] = useState(null);
  const load = () =>
    fetch("/api/automatik")
      .then((r) => (r.ok ? r.json() : null))
      .then(setA)
      .catch(() => {});
  useEffect(() => {
    load();
  }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return null;
  const set = async (k, v) => {
    const r = await fetch("/api/automatik/einstellungen", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [k]: v }) }).catch(() => null);
    if (r && r.ok) setA({ ...a, einstellungen: (await r.json()).einstellungen });
  };
  return (
    <div className="card vs-card" style={{ marginBottom: 16 }}>
      <div className="sec-head">
        <div>
          <h2>Automatisch nach dem Wareneingang</h2>
          <p>Ist die Ware laut Odoo eingegangen, geht die Position von selbst weiter. Vollständig ausgelieferte Aufträge schließt die App selbst.</p>
        </div>
      </div>
      <div className="vs-auto">
        <label>
          Fertigung extern →{" "}
          <select value={a.einstellungen.nachFremd} onChange={(e) => set("nachFremd", e.target.value)}>
            <option value="qs">{ZIEL.qs}</option>
            <option value="versand">{ZIEL.versand}</option>
          </select>
        </label>
        <label>
          Oberfläche extern →{" "}
          <select value={a.einstellungen.nachOberflaeche} onChange={(e) => set("nachOberflaeche", e.target.value)}>
            <option value="versand">{ZIEL.versand}</option>
            <option value="qs">QS</option>
          </select>
        </label>
        <span className="fg-faint">Ohne Kundenauftrag statt Versand: erledigt.</span>
      </div>
      {a.protokoll && a.protokoll.length > 0 && (
        <ul className="fg-notes vs-log">
          {a.protokoll.slice(0, 8).map((p, i) => (
            <li key={i}>
              <button type="button" className="vs-loglink" onClick={() => p.id && onOpen(p.id)}>
                {day(p.am.slice(0, 10))}: {p.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Versand({ orders, reloadKey, onOpen, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(null);
  const load = (neu) =>
    fetch("/api/versand" + (neu ? "?neu=1" : ""))
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || "nicht erreichbar")))))
      .then((j) => {
        setD(j);
        setErr("");
        // gerade als versendet erkannt: Planung neu laden, damit die Positionen hier verschwinden
        if (j.versendet) onChanged && onChanged();
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load(false);
  }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const infoOf = useMemo(() => new Map(((d && d.versand) || []).map((v) => [v.id, v])), [d]);
  const groups = useMemo(() => {
    const m = new Map();
    orders
      .filter((o) => o.machine === "versand" && !o.done)
      .forEach((o) => {
        const k = o.source || posNo(o);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(o);
      });
    return [...m.entries()]
      .map(([k, list]) => ({ k, list, due: list.map((o) => o.due).filter(Boolean).sort()[0] || null, seit: list.map((o) => o.extern_start).filter(Boolean).sort()[0] || null }))
      .sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")));
  }, [orders]);

  async function versendet(o) {
    setBusy(o.id);
    try {
      const r = await fetch(`/api/versand/${o.id}/versendet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Hat nicht geklappt");
      onChanged && onChanged();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  const zb = (d && d.zuBerechnen) || [];
  const summe = zb.reduce((t, z) => t + (z.wert || 0), 0);
  const a = d && d.aufgabe;
  return (
    <>
      <Automatik reloadKey={reloadKey} onOpen={onOpen} />
      <div className="card vs-card" style={{ marginBottom: 16 }}>
        <div className="sec-head">
          <div>
            <h2>Versandbereit</h2>
            <p>Nach QS und Extern: verpacken, Lieferschein, raus. Ist die Lieferung in Odoo bestätigt, gilt die Position als versendet und wandert nach „Erledigt“.</p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {groups.length > 0 && <span className="pill mute">{groups.length} {groups.length === 1 ? "Auftrag" : "Aufträge"}</span>}
            <button type="button" className="btn sm" onClick={() => load(true)} title="Lieferungen jetzt in Odoo prüfen">
              Jetzt prüfen
            </button>
          </div>
        </div>
        {err && <div className="note" style={{ margin: 12 }}>Versand: {err}</div>}
        {groups.length === 0 ? (
          <div className="fg-faint" style={{ padding: 18 }}>Gerade ist nichts versandbereit.</div>
        ) : (
          <div className="vs-list">
            {groups.map((g) => (
              <div className={`fg-card${g.due && g.due < new Date().toISOString().slice(0, 10) ? " warnung" : ""}`} key={g.k}>
                <div className="fg-top">
                  <b className="mono">{g.k}</b>
                  {g.list[0].customer && <span>{g.list[0].customer}</span>}
                  <span className="fg-faint">Liefertermin {day(g.due)}</span>
                  {g.seit && <span className="fg-faint">versandbereit seit {day(g.seit)}</span>}
                </div>
                {g.list.map((o) => {
                  const v = infoOf.get(o.id);
                  const info = (v && v.info) || o.ship_info;
                  return (
                    <div className="vs-pos" key={o.id}>
                      <button type="button" className="vs-main" onClick={() => onOpen(o.id)} title="Details öffnen">
                        <span className="mono">{posNo(o)}</span>
                        <span className="vs-prod">{o.product || ""}</span>
                        {o.quantity != null && <span className="fg-faint">{fmtH(o.quantity)} Stück</span>}
                        {info && <span className={`pill ${/Teillieferung/.test(info) ? "warn" : "mute"}`}>{info}</span>}
                      </button>
                      <button type="button" className="btn sm" disabled={busy === o.id} onClick={() => versendet(o)} title="Ohne bestätigte Lieferung in Odoo, z. B. Abholung: von Hand als versendet melden">
                        <Ico n="check" s={14} /> Versendet
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card vs-card">
        <div className="sec-head">
          <div>
            <h2>Zu berechnen</h2>
            <p>Geliefert, aber noch nicht (vollständig) berechnet, je Auftragsposition nach Menge. Die Rechnung stellst du in Odoo.</p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {zb.length > 0 && <span className="pill warn">{zb.length} {zb.length === 1 ? "Auftrag" : "Aufträge"} · ca. {eur(summe)} netto</span>}
            {a && (
              <span className={`pill ${a.an ? "ok" : "mute"}`} title={a.an ? `Für neue Lieferungen ab ${day(a.start)} legt die App in Odoo eine Aufgabe „Rechnung stellen“ an.` : "Aufgaben in Odoo sind aus (BDE_WRITE fehlt oder VERSAND_AUFGABE=0)."}>
                Aufgabe in Odoo {a.an ? "an" : "aus"}
              </span>
            )}
          </div>
        </div>
        {!d ? (
          <div className="fg-faint" style={{ padding: 18 }}>{err ? "" : "Wird aus Odoo geladen …"}</div>
        ) : !d.enabled ? (
          <div className="fg-faint" style={{ padding: 18 }}>Odoo ist nicht angebunden.</div>
        ) : zb.length === 0 ? (
          <div className="fg-faint" style={{ padding: 18 }}>Alles Gelieferte ist berechnet.</div>
        ) : (
          <div className="vs-list">
            {zb.map((z) => (
              <div className="fg-card" key={z.sale}>
                <div className="fg-top">
                  <b className="mono">{z.sale}</b>
                  {z.kunde && <span>{z.kunde}</span>}
                  <span className="fg-faint">
                    versendet {day(z.versendetAm)}
                    {z.lieferung ? ` (${z.lieferung})` : ""}
                  </span>
                  {z.teil && <span className="pill warn">Teillieferung</span>}
                  {z.duplikat && z.duplikat.length > 0 && (
                    <span className="pill mute" title="Gleicher Kunde und gleiche Bestellnummer: Lieferungen und Rechnungen beider Aufträge zählen zusammen">
                      mit {z.duplikat.join(", ")} (gleiche Bestellung)
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <b>{eur(z.wert)}</b>
                </div>
                <ul className="fg-notes">
                  {z.positionen.slice(0, 6).map((p, i) => (
                    <li key={i}>
                      {fmtN(p.offen)} × {p.artikel} <span className="fg-faint">(geliefert {fmtN(p.geliefert)}, berechnet {fmtN(p.berechnet)})</span>
                    </li>
                  ))}
                  {z.positionen.length > 6 && <li className="fg-faint">… {z.positionen.length - 6} weitere</li>}
                </ul>
                <div className="fg-actions">
                  <a className="btn sm odoo" href={`${ODOO_SALE_URL}/${z.saleId}`} target="_blank" rel="noopener noreferrer">
                    Kundenauftrag in Odoo <Ico n="ext" s={13} />
                  </a>
                  {z.aufgabe && z.aufgabe.am && <span className="fg-faint">Aufgabe „Rechnung stellen“ angelegt am {day(z.aufgabe.am)}</span>}
                  {z.aufgabe && z.aufgabe.fehler && <span className="pill bad" title={z.aufgabe.fehler}>Aufgabe nicht angelegt</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
