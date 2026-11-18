import React, { useEffect, useRef, useState } from "react";
import { MACHINES, fmtShort } from "./lib.js";
import { Thumb } from "./ui.jsx";

// KI-Vorschläge zur Freigabe: Die App bereitet vor (AV-Pakete je Fertigungsauftrag, Planvorschlag am Morgen, Hinweise von Talos),
// ein Mensch prüft und gibt frei. Erst mit der Freigabe ändert sich etwas. Freigeben dürfen alle, die mit PIN angemeldet sind.
// server/freigaben.js rechnet und führt aus.

const short = (id) => (MACHINES.find((m) => m.id === id) || {}).short || id;
const h1 = (x) => String(Math.round(x * 10) / 10).replace(".", ",");
const day = (s) => (s ? fmtShort(s) : "–");
const ITEM = { material: "Material", programm: "Programm", werkzeuge: "Werkzeuge", spannmittel: "Spannmittel" };
const PIN = "Bitte zuerst unter „Mein Arbeitsplatz“ mit PIN anmelden, dann freigeben.";
const STATUS = { freigegeben: "freigegeben", abgelehnt: "abgelehnt", hinfaellig: "überholt", offen: "offen" };

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error(PIN);
  if (!r.ok) throw Object.assign(new Error(j.error || "Hat nicht geklappt"), { status: r.status });
  return j;
}

// Gemeinsamer Abruf für Planung und Arbeitsvorbereitung (ein Abruf, mehrere Anzeigen)
let shared = null;
let sharedAt = 0;
const listeners = new Set();
function loadShared(force) {
  if (!force && shared && Date.now() - sharedAt < 20000) return Promise.resolve(shared);
  return fetch("/api/freigaben")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j) {
        shared = j;
        sharedAt = Date.now();
        listeners.forEach((f) => f(j));
      }
      return j;
    })
    .catch(() => null);
}
export function useFreigaben(reloadKey) {
  const [d, setD] = useState(shared);
  useEffect(() => {
    listeners.add(setD);
    loadShared(false).then((j) => j && setD(j));
    return () => listeners.delete(setD);
  }, [reloadKey]);
  return [d, () => loadShared(true)];
}

// Ein AV-Paket: was die App vorschlägt, woher es kommt, Warnungen
function PaketInhalt({ p }) {
  const notes = Object.entries(p.notes || {});
  return (
    <div className="fg-paket">
      {p.hours > 0 && (
        <div>
          <b>{h1(p.hours)} h</b> <span className="fg-faint">{p.hoursSrc}</span>
        </div>
      )}
      {p.machine && (
        <div>
          Maschine <b>{short(p.machine.id)}</b> <span className="fg-faint">{p.machine.why}</span>
        </div>
      )}
      {notes.length > 0 && (
        <ul className="fg-notes">
          {notes.map(([k, v]) => (
            <li key={k}>
              <b>{ITEM[k] || k}:</b> {v}
            </li>
          ))}
        </ul>
      )}
      {Object.entries(p.status || {}).map(([k, v]) => (
        <div key={k}>
          <b>{ITEM[k] || k}</b> → {v}
        </div>
      ))}
      {p.zeichnung && (
        <div className="fg-faint">
          Zeichnung {p.zeichnung.anhang || ""}{p.zeichnung.index ? ` · Index ${p.zeichnung.index}` : ""}{p.zeichnung.abmessungen ? ` · ${p.zeichnung.abmessungen}` : ""}{p.zeichnung.sicherheit && p.zeichnung.sicherheit !== "hoch" ? ` · gelesen mit Sicherheit ${p.zeichnung.sicherheit}` : ""}{p.zeichnung.grund ? ` · ${p.zeichnung.grund}` : ""}
        </div>
      )}
      {p.programmingMin > 0 && <div className="fg-faint">Programmieren laut Kalkulation: {Math.round(p.programmingMin)} min</div>}
      {(p.warnungen || []).map((w) => (
        <div key={w} className="fg-warn">
          ⚠ {w}
        </div>
      ))}
      {(p.hinweise || []).map((w) => (
        <div key={w} className="fg-hint">
          {w}
        </div>
      ))}
      {p.kalkFehler && <div className="fg-faint">Kalkulation nicht erreichbar: {p.kalkFehler}</div>}
    </div>
  );
}

function Entscheiden({ f, onDone, labelYes = "Freigeben", labelNo = "Ablehnen", extra }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [why, setWhy] = useState(null); // Begründung beim Ablehnen
  const decide = async (aktion) => {
    setBusy(aktion);
    setErr("");
    try {
      const j = await post(`/api/freigaben/${f.id}`, { aktion, notiz: aktion === "ablehnen" ? why || "" : "" });
      onDone && onDone(j);
    } catch (e) {
      setErr(e.message);
      if (e.status === 409) onDone && onDone(null);
    } finally {
      setBusy("");
      setWhy(null);
    }
  };
  return (
    <div className="fg-actions">
      <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => decide("freigeben")}>
        {busy === "freigeben" ? "Übernehme …" : labelYes}
      </button>
      {why === null ? (
        <button type="button" className="btn sm" disabled={!!busy} onClick={() => setWhy("")}>
          {labelNo}
        </button>
      ) : (
        <span className="fg-why">
          <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Warum? (freiwillig)" maxLength={300} autoFocus onKeyDown={(e) => e.key === "Enter" && decide("ablehnen")} />
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => decide("ablehnen")}>
            {labelNo}
          </button>
        </span>
      )}
      {extra}
      {err && <span className="fg-err">{err}</span>}
    </div>
  );
}

function ZeichnungKnopf({ f, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      await post(`/api/freigaben/${f.id}/zeichnung`, {});
      onDone && onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn sm" disabled={busy} onClick={run} title="Zeichnung aus Odoo von der KI lesen lassen: Werkstoff, Oberfläche, Härte, Toleranzen; Abgleich mit Arbeitsplan und Kalkulation">
        {busy ? "Lese Zeichnung …" : f.daten.zeichnung && f.daten.zeichnung.anhang ? "Zeichnung neu lesen" : "Zeichnung lesen"}
      </button>
      {err && <span className="fg-err">{err}</span>}
    </>
  );
}

function KalkKnopf({ f, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const p = f.daten;
  if (!p.kalkMoeglich) return p.kalkLink ? <a className="btn sm" href={p.kalkLink} target="_blank" rel="noreferrer">In der Kalkulation öffnen</a> : null;
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      await post(`/api/freigaben/${f.id}/kalkulation`, {});
      onDone && onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn sm" disabled={busy} onClick={run} title="Legt das Teil in der Kalkulation an (falls neu), rechnet es mit der STEP-Datei durch und übernimmt die Zeiten in dieses Paket. In Odoo ändert sich nichts.">
        {busy ? "Kalkulation rechnet (bis 3 min) …" : "In der Kalkulation berechnen"}
      </button>
      {err && <span className="fg-err">{err}</span>}
    </>
  );
}

function PlanKarte({ f, onDone, onHighlight }) {
  const p = f.daten;
  const [more, setMore] = useState(false);
  const nothing = !p.einplanen.length && !p.umgestellt;
  const basis = p.nachEinplanen || p.vorher;
  const spaet = p.schonSpaet || [];
  const gewinn = basis.tage - p.nachher.tage;
  return (
    <div className="fg-card fg-plan">
      <div className="fg-top">
        <b>{f.titel}</b>
        <span className="fg-faint">
          {f.quelle === "Talos" ? "Text von Talos" : "von der App"} · {new Date(f.geaendert || f.erstellt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <div className="fg-text">{f.text}</div>
      {!nothing && (
        <>
          <div className="fg-effects">
            {p.einplanen.length > 0 && (
              <div className={`fg-effect${spaet.length ? "" : " good"}`}>
                <b>Einplanen:</b> {p.einplanen.length} {p.einplanen.length === 1 ? "Position" : "Positionen"}, {p.einplanen.length - spaet.length} pünktlich
                {spaet.length > 0 && (
                  <span className="fg-faint">
                    {" "}
                    · {spaet.length} schon zu spät (waren bisher nur nicht eingeplant: {[...new Set(spaet.map((x) => x.source || x.ref))].join(", ")})
                  </span>
                )}
              </div>
            )}
            {p.umgestellt > 0 && (
              <div className={`fg-effect${gewinn > 0 ? " good" : ""}`}>
                <b>Umstellen:</b> {p.umgestellt} {p.umgestellt === 1 ? "Position" : "Positionen"} ·{" "}
                {gewinn > 0 ? <>spart <b>{gewinn}</b> Verspätungstage</> : "ändert an den Verspätungstagen nichts"}
                {basis.zuSpaet > p.nachher.zuSpaet && <>, {basis.zuSpaet - p.nachher.zuSpaet} Aufträge weniger zu spät</>}
              </div>
            )}
          </div>
          <div className="fg-actions">
            <button type="button" className="fg-more" onClick={() => setMore((v) => !v)}>
              {more ? "Einzelheiten ausblenden" : "Was genau ändert sich?"}
            </button>
            {onHighlight && (p.geaendertIds || []).length > 0 && (
              <button type="button" className="fg-more" onClick={() => onHighlight(p.geaendertIds)} title="Die betroffenen Positionen im Zeitstrahl hervorheben">
                Im Zeitstrahl zeigen
              </button>
            )}
          </div>
          {more && (
            <div className="fg-detail">
              {p.einplanen.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Einplanen</th>
                      <th>Kunde</th>
                      <th>Maschine</th>
                      <th>Start → Ende</th>
                      <th>Termin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.einplanen.map((e) => (
                      <tr key={e.id}>
                        <td>
                          {e.ref} <span className="fg-faint">{e.source}</span>
                        </td>
                        <td>{e.customer || "–"}</td>
                        <td>
                          {e.machineName} · Platz {e.platz}
                        </td>
                        <td>
                          {day(e.start)} → {day(e.ende)}
                        </td>
                        <td className={e.status === "late" ? "bad" : e.status === "tight" ? "warn" : ""}>{e.status === "late" ? `${e.lateDays} Tg. zu spät` : e.status === "tight" ? "knapp" : "pünktlich"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {p.umordnen.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Auftrag</th>
                      <th>Fertig vorher → nachher</th>
                      <th>Termin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.umordnen.map((a) => (
                      <tr key={a.auftrag}>
                        <td>{a.auftrag}</td>
                        <td>
                          {day(a.vorher)} → {day(a.nachher)} <span className={a.tage > 0 ? "bad" : "ok"}>({a.tage > 0 ? "+" : ""}{a.tage} Tg.)</span>
                        </td>
                        <td>{day(a.liefertermin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
      <Entscheiden f={f} onDone={onDone} labelYes={nothing ? "Gelesen" : "Plan freigeben"} labelNo={nothing ? "Ausblenden" : "Ablehnen"} />
    </div>
  );
}

function AvKarte({ f, onDone, compact }) {
  const p = f.daten;
  return (
    <div className={`fg-card fg-av${p.warnungen?.length ? " warnung" : ""}`}>
      {!compact && (
        <div className="fg-top">
          {p.odooId && <Thumb src={"/api/part-image/" + p.odooId} size={44} />}
          <b>{p.ref}</b>
          <span>{p.source}</span>
          <span className="fg-faint fg-prod">
            {p.product} {p.quantity ? `· ${p.quantity} Stk` : ""} {p.due ? `· Termin ${day(p.due)}` : ""}
          </span>
        </div>
      )}
      <PaketInhalt p={p} />
      <Entscheiden f={f} onDone={onDone} extra={<><KalkKnopf f={f} onDone={() => onDone && onDone(null)} /><ZeichnungKnopf f={f} onDone={() => onDone && onDone(null)} /></>} />
    </div>
  );
}

// Was ein AV-Paket ändern würde, in Kurzform
export function aenderungen(p) {
  const out = [];
  if (p.hours > 0) out.push(`Stunden – → ${h1(p.hours)} h`);
  for (const [k, v] of Object.entries(p.status || {})) out.push(`${ITEM[k] || k}: offen → ${v}`);
  for (const k of Object.keys(p.notes || {})) if (!(p.status || {})[k]) out.push(`Hinweis ${ITEM[k] || k}`);
  if (p.machine && p.machine.id === "m1" && p.machine.why === "laut Kalkulation") out.push("passt auf M1");
  return out;
}
const hatWarnung = (f) => (f.daten.warnungen || []).length > 0;
export const istSicher = (f) => !hatWarnung(f) && aenderungen(f.daten).length > 0;

function AvListe({ items, onDone, onChanged }) {
  // Mit Warnung zuerst (brauchen einen Blick), dann nach Liefertermin
  const list = [...items].sort((a, b) => hatWarnung(b) - hatWarnung(a) || (a.daten.due || "9999").localeCompare(b.daten.due || "9999") || a.id - b.id);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const box = useRef(null);
  const i = Math.min(sel, Math.max(0, list.length - 1));
  const sicher = list.filter(istSicher);
  const decide = async (f, aktion) => {
    setBusy(true);
    setMsg("");
    try {
      const j = await post(`/api/freigaben/${f.id}`, { aktion });
      setMsg(j.ergebnis ? `${f.daten.ref}: ${j.ergebnis}` : `${f.daten.ref}: ${aktion === "ablehnen" ? "abgelehnt" : "freigegeben"}`);
      onDone(null);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  const releaseAll = async () => {
    setBusy(true);
    setMsg("");
    let n = 0;
    try {
      for (const f of sicher) {
        await post(`/api/freigaben/${f.id}`, { aktion: "freigeben" });
        n++;
      }
      setMsg(`${n} sichere AV-${n === 1 ? "Paket" : "Pakete"} freigegeben.`);
    } catch (e) {
      setMsg(`${n} freigegeben, dann: ${e.message}`);
    } finally {
      setBusy(false);
      onDone(null);
      onChanged && onChanged();
    }
  };
  const onKey = (e) => {
    if (e.target.closest("input, textarea, select")) return;
    const f = list[i];
    if (e.key === "ArrowDown" || e.key === "j") (e.preventDefault(), setSel(Math.min(list.length - 1, i + 1)));
    else if (e.key === "ArrowUp" || e.key === "k") (e.preventDefault(), setSel(Math.max(0, i - 1)));
    else if (!busy && f && (e.key === "f" || e.key === "F")) (e.preventDefault(), decide(f, "freigeben"));
    else if (!busy && f && (e.key === "a" || e.key === "A")) (e.preventDefault(), decide(f, "ablehnen"));
  };
  if (!list.length) return null;
  return (
    <div className="fg-sec">
      <div className="fg-sec-head">
        <b>AV-Pakete ({list.length})</b>
        <span className="fg-faint">Tastatur: ↑ ↓ wählen · F freigeben · A ablehnen</span>
        {sicher.length > 1 && (
          <button type="button" className="btn sm primary" disabled={busy} onClick={releaseAll} title="Alle Pakete ohne Warnung, die etwas eintragen">
            {sicher.length} sichere freigeben
          </button>
        )}
      </div>
      {msg && <div className="fg-msg">{msg}</div>}
      <div className="fg-list" tabIndex={0} ref={box} onKeyDown={onKey}>
        {list.map((f, k) => {
          const p = f.daten;
          const ch = aenderungen(p);
          const warn = (p.warnungen || []).length;
          const on = k === i;
          return (
            <div key={f.id} className={`fg-row${on ? " sel" : ""}${warn ? " warnung" : ""}`}>
              <button type="button" className="fg-row-head" onClick={() => (setSel(k), box.current && box.current.focus())} aria-expanded={on}>
                <b>{p.ref}</b>
                <span className="fg-faint fg-row-sub">
                  {p.source || ""}
                  {p.due ? ` · Termin ${day(p.due)}` : ""}
                </span>
                <span className="fg-chips">
                  {warn > 0 && <span className="fg-chip bad">⚠ {warn === 1 ? "Warnung" : `${warn} Warnungen`}</span>}
                  {ch.map((c) => (
                    <span key={c} className="fg-chip">
                      {c}
                    </span>
                  ))}
                  {!ch.length && !warn && <span className="fg-chip mute">nur Hinweise</span>}
                </span>
              </button>
              {on && (
                <div className="fg-row-detail">
                  <div className="fg-faint fg-prod">
                    {p.product} {p.quantity ? `· ${p.quantity} Stk` : ""}
                  </div>
                  <PaketInhalt p={p} />
                  <Entscheiden f={f} onDone={onDone} extra={<><KalkKnopf f={f} onDone={() => onDone && onDone(null)} /><ZeichnungKnopf f={f} onDone={() => onDone && onDone(null)} /></>} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HinweisKarte({ f, onDone }) {
  return (
    <div className="fg-card fg-hin">
      <div className="fg-top">
        <b>{f.titel}</b>
        <span className="fg-faint">
          {f.quelle}
          {f.bezug ? ` · ${f.bezug}` : ""}
        </span>
      </div>
      {f.text && <div className="fg-text">{f.text}</div>}
      <Entscheiden f={f} onDone={onDone} labelYes="Erledigt" labelNo="Verwerfen" />
    </div>
  );
}

// Verlauf: was wurde wann von wem entschieden
function Verlauf() {
  const [list, setList] = useState(null);
  useEffect(() => {
    fetch("/api/freigaben?status=alle")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setList(j.items.filter((f) => f.status !== "offen")))
      .catch(() => setList([]));
  }, []);
  if (!list) return <div className="fg-faint">Verlauf wird geladen …</div>;
  if (!list.length) return <div className="fg-faint">Noch nichts entschieden.</div>;
  return (
    <table className="fg-log">
      <tbody>
        {list.slice(0, 60).map((f) => (
          <tr key={f.id}>
            <td>{new Date(f.entschieden || f.erstellt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
            <td className={`st ${f.status}`}>{STATUS[f.status] || f.status}</td>
            <td>{f.titel}</td>
            <td className="fg-faint">
              {f.von}
              {f.notiz ? ` · ${f.notiz}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Freigaben({ reloadKey, open: openProp, onToggle, onChanged, embedded = false, onHighlight }) {
  const open = embedded || openProp;
  const [d, reload] = useFreigaben(reloadKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState(false);
  const items = (d && d.items) || [];
  const plan = items.filter((f) => f.art === "plan");
  const av = items.filter((f) => f.art === "av");
  const hin = items.filter((f) => f.art === "hinweis");
  const done = (j) => {
    if (j && j.ergebnis) setMsg(j.ergebnis);
    reload();
    onChanged && onChanged();
  };
  const prepare = async () => {
    setBusy(true);
    setMsg("");
    try {
      const j = await post("/api/freigaben/vorbereiten", {});
      setMsg(`Neu vorbereitet: ${j.av} AV-${j.av === 1 ? "Paket" : "Pakete"} geprüft, Planvorschlag gerechnet.`);
      reload();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id="freigaben" className={embedded ? "freigaben fg-embedded" : "freigaben note rise"} style={embedded ? undefined : { "--i": 1 }}>
      {!embedded && (
      <div className="fg-head">
        <button type="button" className="fg-title" onClick={onToggle} aria-expanded={open}>
          <b>KI-Vorschläge zur Freigabe</b>
          <span className={`fg-count${items.length ? " on" : ""}`}>{items.length}</span>
          <span className="fg-faint">
            {items.length
              ? [plan.length ? "Planvorschlag" : null, av.length ? `${av.length} AV-${av.length === 1 ? "Paket" : "Pakete"}` : null, hin.length ? `${hin.length} ${hin.length === 1 ? "Hinweis" : "Hinweise"}` : null].filter(Boolean).join(" · ")
              : "Nichts offen. Die App bereitet neue Aufträge und morgens den Plan vor."}
          </span>
          <span className="ht-go">{open ? "▾" : "›"}</span>
        </button>
        {open && (
          <span className="fg-tools">
            <button type="button" className="btn sm" disabled={busy} onClick={prepare} title="AV-Pakete und Planvorschlag jetzt neu rechnen">
              {busy ? "Rechne …" : "Neu vorbereiten"}
            </button>
            <button type="button" className="btn sm" onClick={() => setLog((v) => !v)}>
              {log ? "Offene zeigen" : "Verlauf"}
            </button>
          </span>
        )}
      </div>
      )}
      {open && (
        <div className="fg-body">
          {msg && <div className="fg-msg">{msg}</div>}
          <div className="fg-faint fg-rule">Die App ändert erst etwas, wenn du freigibst. Freigeben kann jeder, der unter „Mein Arbeitsplatz“ mit PIN angemeldet ist; festgehalten wird, wer es war.</div>
          {log ? (
            <Verlauf />
          ) : (
            <>
              {plan.map((f) => (
                <PlanKarte key={f.id} f={f} onDone={done} onHighlight={onHighlight} />
              ))}
              {hin.map((f) => (
                <HinweisKarte key={f.id} f={f} onDone={done} />
              ))}
              <AvListe items={av} onDone={done} onChanged={onChanged} />
              {!items.length && <div className="fg-faint">Gerade ist nichts freizugeben.</div>}
            </>
          )}
          {embedded && (
            <div className="fg-actions fg-foot">
              <button type="button" className="btn sm" disabled={busy} onClick={prepare} title="AV-Pakete und Planvorschlag jetzt neu rechnen">
                {busy ? "Rechne …" : "Neu vorbereiten"}
              </button>
              <button type="button" className="btn sm" onClick={() => setLog((v) => !v)}>
                {log ? "Offene zeigen" : "Verlauf"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Für die Arbeitsvorbereitung: das AV-Paket einer Position (wenn es eines gibt) mit Freigeben
export function AvPaket({ orderId, onChanged }) {
  const [d, reload] = useFreigaben(orderId);
  const f = d && d.items.find((x) => x.art === "av" && x.daten.orderId === orderId);
  const [msg, setMsg] = useState("");
  if (!f) return msg ? <div className="fg-msg">{msg}</div> : null;
  return (
    <div className="fg-avbox">
      <div className="fg-sec-head">
        <b>Vorschlag der App</b>
        <span className="fg-faint">prüfen und freigeben</span>
      </div>
      <AvKarte
        f={f}
        compact
        onDone={(j) => {
          if (j && j.ergebnis) setMsg("Übernommen: " + j.ergebnis);
          reload();
          onChanged && onChanged();
        }}
      />
    </div>
  );
}
