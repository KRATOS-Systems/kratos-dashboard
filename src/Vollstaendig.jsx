import React, { useEffect, useState } from "react";
import { daysBetween, fmtShort, todayStr } from "./lib.js";

// Vollständigkeit: Jeder bestätigte Kundenauftrag muss in der Arbeitsvorbereitung oder Planung sichtbar sein.
// Zeigt das Ergebnis der Prüfung nach dem letzten Odoo-Abgleich: fehlende Fertigungsaufträge (Differenz, muss null sein),
// Kundenaufträge ohne Fertigungs- oder Einkaufsbeleg (Warnliste) und gefertigte, aber noch nicht gelieferte Aufträge.
// compact = nur melden, wenn etwas fehlt (für die Planung).

const plural = (n, one, many) => (n === 1 ? one : many);
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Das hat nicht geklappt");
    return j;
  });

export default function Vollstaendig({ compact = false, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [openList, setOpenList] = useState(false);
  const [ackFor, setAckFor] = useState(null); // A-Nummer, für die gerade ein Grund eingegeben wird
  const [note, setNote] = useState("");
  const today = todayStr();

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/odoo/vollstaendigkeit")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => !stop && j && setData(j))
        .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (!data || !data.enabled) return null;
  const r = data.result;
  const act = async (fn) => {
    setBusy(true);
    setErr("");
    try {
      const j = await fn();
      if (j && j.result !== undefined) setData(j);
      if (onChanged) onChanged();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  const check = () => act(() => post("/api/odoo/vollstaendigkeit"));
  const takeOver = (source) =>
    act(async () => {
      await post("/api/odoo/nachholen", { source, force: true });
      return post("/api/odoo/vollstaendigkeit");
    });
  const saveAck = (source, undo) =>
    act(async () => {
      const j = await post("/api/odoo/vollstaendigkeit/geprueft", { source, note, undo });
      setAckFor(null);
      setNote("");
      return j;
    });

  if (!r) {
    if (compact) return null;
    return (
      <div className="vollst note">
        <div className="vo-head">
          <i className="dot" style={{ "--c": "var(--faint)" }} />
          <span>
            <b>Vollständigkeit noch nicht geprüft.</b> {data.error ? `Letzter Versuch: ${data.error}` : "Die Prüfung läuft mit dem nächsten Odoo-Abgleich."}
          </span>
          <button type="button" className="btn sm" disabled={busy} onClick={check}>
            {busy ? "Prüfe …" : "Jetzt prüfen"}
          </button>
        </div>
        {err && <div className="vo-err">{err}</div>}
      </div>
    );
  }

  const fehlt = r.fehlt || [];
  const ohne = r.ohneBeleg || [];
  const offen = r.lieferungOffen || [];
  if (compact && !fehlt.length) return null;
  const at = r.at ? new Date(r.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "";
  const age = (e) => (e.date ? daysBetween(e.date, today) : null);
  const dueCell = (e) =>
    e.due ? (
      <span className={e.due < today ? "vo-late" : ""}>
        {fmtShort(e.due)}
        {e.due < today ? ` · ${daysBetween(e.due, today)} ${plural(daysBetween(e.due, today), "Tag", "Tage")} überfällig` : ""}
      </span>
    ) : (
      <span className="vo-faint">ohne Liefertermin</span>
    );
  const row = (e, extra) => (
    <div className="vo-row" key={e.source}>
      <b className="vo-no">{e.source}</b>
      <span className="vo-kunde" title={e.customer || ""}>
        {e.customer || "–"}
      </span>
      <span className="vo-due">{dueCell(e)}</span>
      <span className="vo-age">{age(e) != null ? `${age(e)} ${plural(age(e), "Tag", "Tage")} alt` : ""}</span>
      <span className="vo-extra">{extra}</span>
    </div>
  );

  return (
    <div className={`vollst note${fehlt.length ? " bad" : ohne.length ? " warn" : ""}`}>
      <div className="vo-head">
        <i className="dot" style={{ "--c": fehlt.length ? "var(--bad)" : ohne.length ? "var(--warn)" : "var(--ok)" }} />
        <span>
          {fehlt.length ? (
            <b>
              Differenz: {fehlt.length} {plural(fehlt.length, "bestätigter Kundenauftrag fehlt", "bestätigte Kundenaufträge fehlen")} in der App.
            </b>
          ) : (
            <b>Vollständig: Kein bestätigter Kundenauftrag fehlt.</b>
          )}{" "}
          {r.total} laufende Kundenaufträge seit {fmtShort(r.since)}
          {r.since.slice(0, 4)}, davon {r.sichtbar} in Arbeit sichtbar, {offen.length} gefertigt und noch nicht geliefert{ohne.length ? `, ${ohne.length} ohne Beleg` : ""}.
          {at && <span className="vo-faint"> Geprüft um {at} Uhr.</span>}
        </span>
        {!compact && (
          <button type="button" className="btn sm" disabled={busy} onClick={check} title="Gleicht mit Odoo ab und prüft sofort neu">
            {busy ? "Prüfe …" : "Jetzt prüfen"}
          </button>
        )}
      </div>
      {err && <div className="vo-err">{err}</div>}
      {r.poError && !compact && <div className="vo-err">Einkaufsbestellungen waren nicht lesbar ({r.poError}). Aufträge mit reinem Einkauf können deshalb in der Warnliste stehen.</div>}

      {fehlt.length > 0 && (
        <div className="vo-list">
          {fehlt.map((e) =>
            row(
              e,
              <>
                <span title="Fertigungsaufträge, die in der App fehlen">{e.refs.join(", ")}</span>
                <button type="button" className="btn sm" disabled={busy} onClick={() => takeOver(e.source)}>
                  Übernehmen
                </button>
              </>
            )
          )}
        </div>
      )}

      {!compact && ohne.length > 0 && (
        <>
          <div className="vo-sub">
            {ohne.length} {plural(ohne.length, "bestätigter Kundenauftrag hat", "bestätigte Kundenaufträge haben")} weder Fertigungsauftrag noch Einkaufsbestellung. Bitte in Odoo prüfen oder abhaken, wenn nichts zu fertigen ist.
          </div>
          <div className="vo-list">
            {ohne.map((e) =>
              row(
                e,
                ackFor === e.source ? (
                  <>
                    <input
                      autoFocus
                      value={note}
                      maxLength={200}
                      placeholder="Grund, z. B. Lagerware"
                      onChange={(ev) => setNote(ev.target.value)}
                      onKeyDown={(ev) => ev.key === "Enter" && saveAck(e.source, false)}
                      aria-label={"Grund für " + e.source}
                    />
                    <button type="button" className="btn sm primary" disabled={busy} onClick={() => saveAck(e.source, false)}>
                      Speichern
                    </button>
                    <button type="button" className="btn sm quiet" onClick={() => setAckFor(null)}>
                      Abbrechen
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn sm" disabled={busy} onClick={() => (setAckFor(e.source), setNote(""))} title="Aus der Warnliste nehmen: Für diesen Auftrag ist nichts zu fertigen">
                    Nichts zu fertigen
                  </button>
                )
              )
            )}
          </div>
        </>
      )}

      {!compact && offen.length > 0 && (
        <>
          <button type="button" className="vo-toggle" onClick={() => setOpenList((v) => !v)} aria-expanded={openList}>
            {openList ? "▾" : "▸"} Lieferung offen: {offen.length} {plural(offen.length, "Auftrag ist", "Aufträge sind")} gefertigt oder beschafft, aber noch nicht vollständig geliefert
          </button>
          {openList && (
            <div className="vo-list">
              {offen.map((e) =>
                row(
                  e,
                  <>
                    <span className="vo-faint" title={e.detail || ""}>
                      {e.partial ? "teilweise geliefert · " : ""}
                      {e.detail}
                    </span>
                    {e.ack && (
                      <button type="button" className="btn sm quiet" disabled={busy} onClick={() => saveAck(e.source, true)} title="Zurück in die Warnliste">
                        Haken lösen
                      </button>
                    )}
                  </>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
