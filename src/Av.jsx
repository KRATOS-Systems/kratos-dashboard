import React, { useMemo, useState } from "react";
import { daysBetween, fmtShort } from "./lib.js";
import { AV_ITEMS, AV_STATUS, avCycle, avState, avSummary } from "./avLib.js";
import { AppTile, Thumb, partImg } from "./ui.jsx";

const LANE_IDS = ["qs", "extern_fert", "extern"];
const groupKey = (o) => o.source || o.order_no || `#${o.id}`;
const posNo = (o) => (o.order_no || "ohne Nummer") + (o.part_label ? ` · ${o.part_label}` : "");
const FILTERS = [
  ["offen", "Es fehlt etwas"],
  ["bald", "Startet in 7 Tagen"],
  ["alle", "Alle offenen"],
];
const CLS = { bereit: "bereit", in_arbeit: "arbeit", offen: "offen", entfaellt: "nein" };

// Arbeitsvorbereitung: Welche Positionen sind bereit für die Fertigung und was fehlt noch?
// orders = alle Positionen, checks = Map (Position|Punkt -> { status, due, note }),
// planStart = Map (Position -> { machine, start }) für eingeplante Positionen.
export default function AvView({ orders, checks, planStart, today, onSet, selectedId, onOpen, filter, setFilter }) {
  const [query, setQuery] = useState("");
  const [popKey, setPopKey] = useState(null);

  // Positionen, die offen und nicht an einem Ort (QS, Extern) liegen
  const all = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders
      .filter((o) => !o.done && !LANE_IDS.includes(o.machine))
      .map((o) => ({ o, sum: avSummary(checks, o.id), plan: planStart.get(o.id) || null }))
      .filter(({ o }) => !q || `${o.order_no} ${o.source || ""} ${o.product || ""}`.toLowerCase().includes(q));
  }, [orders, checks, planStart, query]);
  const isUrgent = (r) => !r.sum.ready && r.plan && daysBetween(today, r.plan.start) <= 7;
  const cnt = { offen: all.filter((r) => !r.sum.ready).length, bald: all.filter(isUrgent).length, alle: all.length };
  const rows = all.filter((r) => (filter === "alle" ? true : filter === "bald" ? isUrgent(r) : !r.sum.ready));

  const groups = (() => {
    const map = new Map();
    rows.forEach((r) => {
      const key = groupKey(r.o);
      if (!map.has(key)) map.set(key, { key, label: r.o.source || r.o.order_no || "ohne Nummer", rows: [] });
      map.get(key).rows.push(r);
    });
    const sortKey = (g) => {
      const starts = g.rows.map((r) => r.plan?.start).filter(Boolean).sort();
      const dues = g.rows.map((r) => r.o.due).filter(Boolean).sort();
      return starts[0] || dues[0] || "9999";
    };
    return [...map.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.label.localeCompare(b.label));
  })();

  const cell = (r, item) => {
    const st = avState(checks, r.o.id, item.id);
    const label = AV_STATUS.find((s) => s.id === st.status).short;
    const urgent = st.status === "offen" && isUrgent(r);
    const late = st.due && st.status !== "bereit" && st.status !== "entfaellt" && st.due < today;
    const key = `${r.o.id}|${item.id}`;
    return (
      <td key={item.id}>
        <div className="avcell">
          <button
            type="button"
            className={`av ${urgent ? "urgent" : CLS[st.status]}${popKey === key ? " pop" : ""}`}
            title={`${item.label}: ${AV_STATUS.find((s) => s.id === st.status).label}. Klick = nächster Status${st.note ? `\n${st.note}` : ""}`}
            onClick={(ev) => {
              ev.stopPropagation();
              setPopKey(key);
              onSet(r.o.id, item.id, { status: avCycle(st.status) });
            }}
          >
            {label}
          </button>
          {st.due && st.status !== "entfaellt" && st.status !== "bereit" && (
            <small className="num" style={late ? { color: "var(--bad)", fontWeight: 600 } : undefined}>
              {fmtShort(st.due)}
            </small>
          )}
          {st.note && st.status !== "entfaellt" && <small title={st.note}>{st.note}</small>}
        </div>
      </td>
    );
  };

  return (
    <>
      <div className="page-head rise" style={{ "--i": 0 }}>
        <div>
          <h1>Arbeitsvorbereitung</h1>
          <p>Was ist bereit, was fehlt noch? Die Maschine weist die Planung zu.</p>
        </div>
        <div className="actions filters">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" className={`chipf${filter === id ? " on" : ""}`} onClick={() => setFilter(id)}>
              {label}
              <b>{cnt[id]}</b>
            </button>
          ))}
          <input type="search" placeholder="Suchen" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 190 }} aria-label="Suchen" />
        </div>
      </div>

      <div className="card rise" style={{ "--i": 1 }}>
        <div className="scroll">
          <table className="tbl" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th className="avh">
                  <div className="avh-in">
                    <span style={{ height: 36 }} />
                    <span>Position</span>
                  </div>
                </th>
                <th className="avh">
                  <div className="avh-in">
                    <AppTile id="liefertermin" size={36} i={0} />
                    <span>Liefertermin</span>
                  </div>
                </th>
                <th className="avh">
                  <div className="avh-in">
                    <AppTile id="planung" size={36} i={1} />
                    <span>Planung</span>
                  </div>
                </th>
                {AV_ITEMS.map((it, ix) => (
                  <th className="avh" key={it.id}>
                    <div className="avh-in">
                      <AppTile id={it.id} size={36} i={ix} />
                      <span>{it.label}</span>
                    </div>
                  </th>
                ))}
                <th>Bereit ab</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <div className="empty">
                      <div className="ring">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                      </div>
                      <b style={{ color: "var(--ink)", font: "600 18px var(--f-display)" }}>{filter === "alle" ? "Keine Positionen" : filter === "bald" ? "Nichts startet unvorbereitet" : "Alles bereit"}</b>
                      <span>
                        {filter === "alle"
                          ? "Es gibt keine offenen Positionen."
                          : filter === "bald"
                          ? "In den nächsten 7 Tagen startet nichts, was nicht bereit ist."
                          : "Für alle offenen Positionen ist die Arbeitsvorbereitung abgeschlossen."}
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              {groups.map((g) => {
                const due = g.rows.map((r) => r.o.due).filter(Boolean).sort()[0];
                const readyN = g.rows.filter((r) => r.sum.ready).length;
                return (
                  <React.Fragment key={g.key}>
                    <tr className="gh">
                      <td colSpan={10}>
                        <b>{g.label}</b>
                        {g.rows.length} {g.rows.length === 1 ? "Position" : "Positionen"}
                        {due ? ` · Liefertermin ${fmtShort(due)}` : ""} · {readyN} bereit
                      </td>
                    </tr>
                    {g.rows.map((r) => {
                      const { o, sum, plan } = r;
                      const u = isUrgent(r);
                      const dueLate = o.due && o.due < today;
                      return (
                        <tr key={o.id} className={`row${selectedId === o.id ? " sel" : ""}`} onClick={() => onOpen(o.id)}>
                          <td>
                            <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
                              <Thumb src={partImg(o)} size={64} />
                              <div style={{ minWidth: 0 }}>
                                <b className="mono">{posNo(o)}</b>
                                <div style={{ color: "var(--muted)", fontSize: 12, maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.product || ""}>
                                  {[o.quantity != null ? `${o.quantity} Stück` : null, o.product].filter(Boolean).join(" · ")}
                                </div>
                                <div className="segs" title="AV-Fortschritt">
                                  {AV_ITEMS.map((it) => {
                                    const s = avState(checks, o.id, it.id).status;
                                    return <i key={it.id} className={s === "offen" && u ? "urgent" : CLS[s]} />;
                                  })}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="num" style={dueLate ? { color: "var(--bad)", fontWeight: 600 } : undefined}>
                            {o.due ? fmtShort(o.due) : "–"}
                          </td>
                          <td>
                            {plan ? (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                                {plan.machine} · ab {fmtShort(plan.start)}
                              </span>
                            ) : (
                              <span style={{ color: "var(--faint)" }}>nicht eingeplant</span>
                            )}
                          </td>
                          {AV_ITEMS.map((it) => cell(r, it))}
                          <td className="num" style={{ fontWeight: 600, color: sum.ready ? "var(--ok)" : "var(--ink)" }}>
                            {sum.ready ? "bereit" : sum.readyDate ? fmtShort(sum.readyDate) : "offen"}
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="rise" style={{ "--i": 2, marginTop: 12, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
        Ein Klick auf einen Status schaltet ihn weiter (offen, in Arbeit, bereit). Ein Klick auf die Zeile öffnet die Details mit Termin und Notiz. Der späteste Termin der offenen Punkte ist das „Bereit ab“: Bis dahin wartet die Position in der Planung. Fehlt etwas, ist das nur eine Warnung, eingeplant werden kann die Position trotzdem.
      </div>
    </>
  );
}

// Positionen, die in den nächsten 7 Tagen starten sollen, aber noch nicht bereit sind (für die Zahl am Reiter)
export function avUrgentCount(orders, checks, planStart, today) {
  return orders.filter((o) => {
    if (o.done || LANE_IDS.includes(o.machine)) return false;
    const plan = planStart.get(o.id);
    if (!plan || daysBetween(today, plan.start) > 7) return false;
    return !avSummary(checks, o.id).ready;
  }).length;
}
