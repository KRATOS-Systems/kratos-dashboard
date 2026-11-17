import React, { useEffect, useState } from "react";
import { fmtShort } from "./lib.js";

// Planvorschlag für die Liste "Noch nicht eingeplant": Die App rechnet für jede Position mit Stunden Maschine und Platz aus.
// Gespeichert wird erst, wenn ein Mensch "Übernehmen" drückt (einzeln oder alle). Danach lässt sich jede Karte wie gewohnt verschieben.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const BASIS = {
  odoo: ["laut Odoo-Arbeitsplan", "mute", "Die Maschine steht im Arbeitsplan des Fertigungsauftrags in Odoo."],
  wiederholteil: ["wie beim letzten Mal", "mute", "Dasselbe Teil lief zuletzt auf dieser Maschine."],
  frei: ["Maschine prüfen", "warn", "Odoo nennt keine Maschine und das Teil ist neu. Vorgeschlagen ist die Maschine mit dem besten Termin. Ob das Teil dort gefertigt werden kann, bitte prüfen."],
};

export default function Planvorschlag({ reloadKey, onApply, poolCount }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    let stop = false;
    // kurz warten, damit eine gerade gespeicherte Änderung schon mitgerechnet wird
    const t = setTimeout(
      () =>
        fetch("/api/planvorschlag")
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Der Vorschlag konnte nicht berechnet werden"))))
          .then((j) => !stop && (setData(j), setErr("")))
          .catch((e) => !stop && setErr(e.message)),
      data ? 900 : 0
    );
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reloadKey]);

  if (!poolCount) return null;
  const apply = async (list) => {
    setBusy(true);
    setErr("");
    try {
      await onApply(list);
    } catch (e) {
      setErr(e.message || "Übernehmen hat nicht geklappt");
    }
    setBusy(false);
  };
  const list = data ? data.vorschlaege : [];
  const stillLate = list.filter((p) => p.status === "late").length;
  const onTime = list.length - stillLate;
  const pushed = [...new Set(list.flatMap((p) => p.othersNewLate))];
  const termin = (p) =>
    !p.due ? (
      <span className="pv-faint">ohne Liefertermin</span>
    ) : p.status === "late" ? (
      <span className="pv-late">{plural(p.lateDays, "Tag", "Tage")} zu spät</span>
    ) : p.status === "tight" ? (
      <span className="pv-tight">knapp</span>
    ) : (
      <span className="pv-ok">pünktlich</span>
    );

  return (
    <div className="planvor">
      <div className="pv-bar">
        <button type="button" className={`btn sm${open ? "" : " primary"}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Planvorschlag schließen" : "Planvorschlag berechnen"}
        </button>
        {open && data && list.length > 0 && (
          <>
            <span className="pv-faint">
              Vorschlag für {plural(list.length, "Position", "Positionen")}. Gespeichert wird erst beim Übernehmen.
              {` ${onTime} pünktlich${stillLate ? `, ${stillLate} trotzdem zu spät` : ""}. ${pushed.length ? `Dadurch neu verspätet: ${pushed.join(", ")}.` : "Kein anderer Auftrag wird dadurch verspätet."}`}
            </span>
            <button type="button" className="btn sm" disabled={busy} onClick={() => apply(list)}>
              {busy ? "Übernehme …" : "Alle übernehmen"}
            </button>
          </>
        )}
      </div>
      {open && err && <div className="pv-err">{err}</div>}
      {open && !data && !err && <div className="pv-faint">Rechne …</div>}
      {open && data && list.length === 0 && <div className="pv-faint">Kein Vorschlag möglich: Keine nicht eingeplante Position hat Stunden.</div>}
      {open && data && list.length > 0 && (
        <div className="pv-list">
          {list.map((p) => {
            const [label, cls, tip] = BASIS[p.basis] || BASIS.frei;
            return (
              <div className="pv-row" key={p.id}>
                <div className="pv-who">
                  <b>{p.source}</b>
                  <span title={[p.ref, p.product].filter(Boolean).join(" · ")}>
                    {p.ref !== p.source ? p.ref + " · " : ""}
                    {p.customer || p.product || ""}
                  </span>
                </div>
                <div className="pv-in">
                  <span>{String(p.hours).replace(".", ",")} h</span>
                  <span className="pv-faint">{p.due ? "LT " + fmtShort(p.due) : "–"}</span>
                </div>
                <div className="pv-where">
                  <b>
                    {p.machineName} · Platz {p.platz}
                  </b>
                  <span className="pv-faint" title={"Eingefügt vor: " + p.vor}>
                    {p.vor === "am Ende" ? "am Ende" : "vor " + p.vor}
                  </span>
                </div>
                <div className="pv-when">
                  <span>
                    {fmtShort(p.start)} bis {fmtShort(p.ende)}
                  </span>
                  {termin(p)}
                </div>
                <div className="pv-note">
                  <span className={`pill ${cls}`} title={tip}>
                    {label}
                  </span>
                  {p.draft && (
                    <span className="pill warn" title="Der Fertigungsauftrag ist in Odoo noch im Entwurf">
                      nicht freigegeben
                    </span>
                  )}
                  {p.othersNewLate.length > 0 && (
                    <span className="pill bad" title={"Dadurch neu verspätet: " + p.othersNewLate.join(", ")}>
                      verspätet {p.othersNewLate.join(", ")}
                    </span>
                  )}
                </div>
                <button type="button" className="btn sm" disabled={busy} onClick={() => apply([p])}>
                  Übernehmen
                </button>
              </div>
            );
          })}
        </div>
      )}
      {open && data && data.ohneStunden.length > 0 && (
        <div className="pv-faint pv-foot">
          {plural(data.ohneStunden.length, "Position hat", "Positionen haben")} noch keine Stunden und {data.ohneStunden.length === 1 ? "bekommt" : "bekommen"} deshalb keinen Vorschlag: {data.ohneStunden
            .slice(0, 8)
            .map((o) => o.ref)
            .join(", ")}
          {data.ohneStunden.length > 8 ? " u. a." : ""}. Erst unten die Stunden eintragen.
        </div>
      )}
    </div>
  );
}
