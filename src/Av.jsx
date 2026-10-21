import React, { Suspense, lazy, useMemo, useState } from "react";
import { addDays, daysBetween, fmtShort } from "./lib.js";
import { AV_ITEMS, AV_STATUS, avCycle, avDone, avState, avSummary } from "./avLib.js";
import { AppTile, Ico, Thumb, partImg } from "./ui.jsx";

// Zeichnung und 3D-Modell werden erst geladen, wenn eine Zeile aufgeklappt wird (three.js ist groß)
const PartDocs = lazy(() => import("./PartDocs.jsx"));

const LANE_IDS = ["qs", "extern_fert", "extern"];
const groupKey = (o) => o.source || o.order_no || `#${o.id}`;
const posNo = (o) => (o.order_no || "ohne Nummer") + (o.part_label ? ` · ${o.part_label}` : "");
const FILTERS = [
  ["offen", "Es fehlt etwas"],
  ["bald", "Startet in 7 Tagen"],
  ["alle", "Alle offenen"],
];
const CLS = { bereit: "bereit", in_arbeit: "arbeit", offen: "offen", entfaellt: "nein" };
const store = (k, v) => {
  try {
    if (v === undefined) return window.localStorage.getItem(k);
    window.localStorage.setItem(k, v);
  } catch {
    /* ohne Speicher gilt die Standardansicht */
  }
  return null;
};

// Arbeitsvorbereitung: Welche Positionen sind bereit für die Fertigung und was fehlt noch?
// orders = alle Positionen, checks = Map (Position|Punkt -> { status, due, note, assignee }),
// planStart = Map (Position -> { machine, start }) für eingeplante Positionen,
// leadDays = Vorlauf: So viele Tage vor dem Start auf der Maschine muss alles bereit sein ("Muss bis").
export default function AvView({ orders, checks, planStart, today, onSet, selectedId, onOpen, filter, setFilter, leadDays, repeatOf, people }) {
  const [query, setQuery] = useState("");
  const [popKey, setPopKey] = useState(null);
  const [open, setOpen] = useState(() => new Set()); // aufgeklappte Zeilen (Zeichnung und 3D-Modell)
  const toggleOpen = (id) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const [view, setViewState] = useState(() => (store("kratos-av-view") === "auftrag" ? "auftrag" : "dring"));
  const [person, setPersonState] = useState(() => store("kratos-av-person") || "");
  const setView = (v) => {
    setViewState(v);
    store("kratos-av-view", v);
  };
  const setPerson = (v) => {
    setPersonState(v);
    store("kratos-av-person", v);
  };

  // Positionen, die offen und nicht an einem Ort (QS, Extern) liegen
  const all = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders
      .filter((o) => !o.done && !LANE_IDS.includes(o.machine))
      .map((o) => {
        const sum = avSummary(checks, o.id);
        const plan = planStart.get(o.id) || null;
        const muss = plan ? addDays(plan.start, -leadDays) : null;
        return { o, sum, plan, muss, late: !sum.ready && muss && muss < today ? daysBetween(muss, today) : 0 };
      })
      .filter(({ o }) => !q || `${o.order_no} ${o.source || ""} ${o.product || ""}`.toLowerCase().includes(q));
  }, [orders, checks, planStart, query, leadDays, today]);
  const mine = (r) => {
    if (!person) return true;
    return AV_ITEMS.some((it) => {
      const st = avState(checks, r.o.id, it.id);
      if (avDone(st.status)) return false;
      return person === "__none" ? !st.assignee : st.assignee === person;
    });
  };
  const isUrgent = (r) => !r.sum.ready && r.plan && daysBetween(today, r.plan.start) <= 7;
  const base = all.filter(mine);
  const cnt = { offen: base.filter((r) => !r.sum.ready).length, bald: base.filter(isUrgent).length, alle: base.length };
  const rows = base.filter((r) => (filter === "alle" ? true : filter === "bald" ? isUrgent(r) : !r.sum.ready));

  const sorted = useMemo(() => {
    const key = (r) => (r.muss ? `0${r.muss}` : `1${r.o.due || "9999"}`);
    return [...rows].sort((a, b) => key(a).localeCompare(key(b)) || String(a.o.source).localeCompare(String(b.o.source)) || a.o.id - b.o.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.o.id + "|" + r.muss + "|" + r.sum.ready).join(",")]);

  const groups = (() => {
    const map = new Map();
    rows.forEach((r) => {
      const k = groupKey(r.o);
      if (!map.has(k)) map.set(k, { key: k, label: r.o.source || r.o.order_no || "ohne Nummer", rows: [] });
      map.get(k).rows.push(r);
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
    const urgent = st.status === "offen" && (isUrgent(r) || r.late > 0);
    const late = st.due && st.status !== "bereit" && st.status !== "entfaellt" && st.due < today;
    const key = `${r.o.id}|${item.id}`;
    return (
      <td key={item.id}>
        <div className="avcell">
          <button
            type="button"
            className={`av ${urgent ? "urgent" : CLS[st.status]}${popKey === key ? " pop" : ""}`}
            title={`${item.label}: ${AV_STATUS.find((s) => s.id === st.status).label}. Klick = nächster Status${st.assignee ? `\nZuständig: ${st.assignee}` : ""}${st.note ? `\n${st.note}` : ""}`}
            onClick={(ev) => {
              ev.stopPropagation();
              setPopKey(key);
              onSet(r.o.id, item.id, { status: avCycle(st.status) });
            }}
          >
            {label}
          </button>
          {st.assignee && st.status !== "entfaellt" && <small className="who">{st.assignee}</small>}
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

  const mussCell = (r) => {
    if (r.sum.ready) return <span style={{ color: "var(--ok)", fontWeight: 600 }}>bereit</span>;
    if (!r.muss) return <span style={{ color: "var(--faint)" }}>nicht eingeplant</span>;
    const days = daysBetween(today, r.muss);
    return (
      <div className={`muss ${r.late ? "late" : days <= 2 ? "soon" : ""}`} title={`Start auf ${r.plan.machine} am ${fmtShort(r.plan.start)}, ${leadDays} Tage Vorlauf`}>
        <b>{fmtShort(r.muss)}</b>
        <small>{r.late ? `${r.late} ${r.late === 1 ? "Tag" : "Tage"} überfällig` : days === 0 ? "heute" : days === 1 ? "morgen" : `in ${days} Tagen`}</small>
      </div>
    );
  };

  const posCell = (r, showOrder) => {
    const { o } = r;
    const rep = repeatOf && repeatOf.get(o.id);
    return (
      <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
        <Thumb src={partImg(o)} size={64} />
        <div style={{ minWidth: 0 }}>
          {showOrder && <div className="posord">{o.source || o.order_no || "ohne Auftrag"}</div>}
          <b className="mono">{posNo(o)}</b>
          <div style={{ color: "var(--muted)", fontSize: 12, maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.product || ""}>
            {[o.quantity != null ? `${o.quantity} Stück` : null, o.product].filter(Boolean).join(" · ")}
          </div>
          {rep && (
            <div className="repeat" title={`Gleiches Teil wie ${posNo(rep)}: AV-Stand kann übernommen werden`}>
              ↻ Wiederholteil von {posNo(rep)}
            </div>
          )}
          <div className="segs" title="AV-Fortschritt">
            {AV_ITEMS.map((it) => {
              const s = avState(checks, o.id, it.id).status;
              return <i key={it.id} className={s === "offen" && (isUrgent(r) || r.late > 0) ? "urgent" : CLS[s]} />;
            })}
          </div>
        </div>
      </div>
    );
  };

  const dataRow = (r, showOrder) => {
    const { o, sum, plan } = r;
    const dueLate = o.due && o.due < today;
    const isOpen = open.has(o.id);
    const mat = avState(checks, o.id, "material");
    const matText = [
      "Material: " + AV_STATUS.find((s) => s.id === mat.status).label,
      mat.due ? "bereit am " + fmtShort(mat.due) : "",
      mat.note || "",
      o.component_status ? "laut Odoo: " + o.component_status : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <React.Fragment key={o.id}>
      <tr className={`row${selectedId === o.id ? " sel" : ""}${r.late ? " ovd" : ""}${isOpen ? " xopen" : ""}`} onClick={() => onOpen(o.id)}>
        <td className="xcell">
          <button
            type="button"
            className={"xbtn" + (isOpen ? " on" : "")}
            aria-expanded={isOpen}
            aria-label={isOpen ? "Zeichnung und 3D-Modell einklappen" : "Zeichnung und 3D-Modell zeigen"}
            title={isOpen ? "Einklappen" : "Zeichnung und 3D-Modell zeigen"}
            onClick={(ev) => {
              ev.stopPropagation();
              toggleOpen(o.id);
            }}
          >
            <Ico n="down" s={16} />
          </button>
        </td>
        <td>{posCell(r, showOrder)}</td>
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
        <td>{mussCell(r)}</td>
        {AV_ITEMS.map((it) => cell(r, it))}
        <td className="num" style={{ fontWeight: 600, color: sum.ready ? "var(--ok)" : "var(--ink)" }}>
          {sum.ready ? "bereit" : sum.readyDate ? fmtShort(sum.readyDate) : "offen"}
        </td>
      </tr>
      {isOpen && (
        <tr className="xrow">
          <td colSpan={COLS}>
            {o.odoo_id ? (
              <Suspense fallback={<div className="pdocs-empty">Wird geladen …</div>}>
                <PartDocs o={o} material={matText} />
              </Suspense>
            ) : (
              <div className="pdocs-empty">Diese Position hat keine Verbindung zu Odoo, daher gibt es keine Zeichnung und kein Modell.</div>
            )}
          </td>
        </tr>
      )}
      </React.Fragment>
    );
  };

  const COLS = 12;
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
          <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Zuständig" title="Nur Aufgaben dieser Person zeigen">
            <option value="">Zuständig: alle</option>
            {people.map((n) => (
              <option key={n} value={n}>
                Zuständig: {n}
              </option>
            ))}
            <option value="__none">Ohne Zuständigen</option>
          </select>
          <div className="seg" role="group" aria-label="Sortierung">
            <button type="button" className={view === "dring" ? "on" : ""} onClick={() => setView("dring")} title="Nach Muss-bis-Termin: Das Dringendste steht oben">
              Dringlichkeit
            </button>
            <button type="button" className={view === "auftrag" ? "on" : ""} onClick={() => setView("auftrag")} title="Nach Aufträgen gruppiert">
              Aufträge
            </button>
          </div>
          <input type="search" placeholder="Suchen" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 170 }} aria-label="Suchen" />
        </div>
      </div>

      <div className="card rise" style={{ "--i": 1 }}>
        <div className="scroll">
          <table className="tbl" style={{ minWidth: 1100 }}>
            <thead>
              <tr>
                <th className="avh" style={{ width: 40, padding: 0 }} />
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
                <th className="avh">
                  <div className="avh-in">
                    <AppTile id="muss" size={36} i={2} />
                    <span>Muss bis</span>
                  </div>
                </th>
                {AV_ITEMS.map((it, ix) => (
                  <th className="avh" key={it.id}>
                    <div className="avh-in">
                      <AppTile id={it.id} size={36} i={ix + 3} />
                      <span>{it.label}</span>
                    </div>
                  </th>
                ))}
                <th>Bereit ab</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={COLS}>
                    <div className="empty">
                      <div className="ring">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                      </div>
                      <b style={{ color: "var(--ink)", font: "600 18px var(--f-display)" }}>{person ? "Nichts für diese Auswahl" : filter === "alle" ? "Keine Positionen" : filter === "bald" ? "Nichts startet unvorbereitet" : "Alles bereit"}</b>
                      <span>
                        {person
                          ? "Für diese Person ist nichts offen. Wähle oben „Zuständig: alle“."
                          : filter === "alle"
                          ? "Es gibt keine offenen Positionen."
                          : filter === "bald"
                          ? "In den nächsten 7 Tagen startet nichts, was nicht bereit ist."
                          : "Für alle offenen Positionen ist die Arbeitsvorbereitung abgeschlossen."}
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              {view === "dring" && sorted.map((r) => dataRow(r, true))}
              {view === "auftrag" &&
                groups.map((g) => {
                  const due = g.rows.map((r) => r.o.due).filter(Boolean).sort()[0];
                  const readyN = g.rows.filter((r) => r.sum.ready).length;
                  return (
                    <React.Fragment key={g.key}>
                      <tr className="gh">
                        <td colSpan={COLS}>
                          <div className="ghead">
                            <span className="gnum">{g.label}</span>
                            {due ? (
                              <span className={"gdue" + (due < today ? " late" : daysBetween(today, due) <= 7 ? " soon" : "")} title={due < today ? "Liefertermin überschritten" : "Liefertermin"}>
                                <svg width="15" height="15" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <rect x="5" y="7" width="22" height="20" rx="3" />
                                  <path d="M5 13h22M11 4v5M21 4v5" />
                                </svg>
                                Liefertermin {fmtShort(due)}
                              </span>
                            ) : (
                              <span className="gdue none">ohne Liefertermin</span>
                            )}
                            <span className="gmeta">
                              {g.rows.length} {g.rows.length === 1 ? "Position" : "Positionen"} · {readyN} bereit
                            </span>
                          </div>
                        </td>
                      </tr>
                      {g.rows.map((r) => dataRow(r, false))}
                    </React.Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="rise" style={{ "--i": 2, marginTop: 12, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
        „Muss bis“ ist der Tag, bis zu dem alles bereit sein muss: Start auf der Maschine minus {leadDays} {leadDays === 1 ? "Tag" : "Tage"} Vorlauf (einstellbar unter Planung, Einstellungen). Ein Klick auf einen Status schaltet ihn weiter (offen, in Arbeit, bereit). Ein Klick auf die Zeile öffnet die Details mit Termin, Zuständigem und Notiz. Der späteste Termin der offenen Punkte ist das „Bereit ab“: Bis dahin wartet die Position in der Planung. Fehlt etwas, ist das nur eine Warnung.
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
