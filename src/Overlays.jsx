import React, { useEffect, useMemo, useRef, useState } from "react";
import { fmtShort } from "./lib.js";
import { AppTile, Ico, SparkIcon, Thumb, partImg } from "./ui.jsx";
import { getDashFacts } from "./store.js";

// Hinweise, Suche und Talos arbeiten auf einer einfachen Liste der offenen Positionen (shared.positions),
// die die Planung bereitstellt.

const dayWord = (n) => `${n} ${n === 1 ? "Tag" : "Tage"}`;

export function alertsList(shared) {
  const pos = shared?.positions || [];
  const late = [];
  const seen = new Set();
  pos
    .filter((p) => p.status === "late")
    .sort((a, b) => b.lateDays - a.lateDays)
    .forEach((p) => {
      if (seen.has(p.source)) return;
      seen.add(p.source);
      late.push({ id: p.id, title: p.source, text: `${dayWord(p.lateDays)} nach dem Liefertermin (${fmtShort(p.due)})${p.endName ? (p.endIsLane ? `, verzögert durch ${p.endName}` : `, letzte Position endet auf ${p.endName}`) : ""}` });
    });
  const soon = pos
    .filter((p) => p.urgent)
    .map((p) => ({ id: p.id, title: p.no, text: `${p.source} · startet ${fmtShort(p.start)}, fehlt: ${p.av.open.map((s) => s.label).join(", ")}` }));
  const mat = pos
    .filter((p) => p.start && p.startIn <= 14 && p.materialMissing)
    .map((p) => ({ id: p.id, title: p.no, text: `${p.source} · Material fehlt laut Odoo, Start ${fmtShort(p.start)}` }));
  return [
    { title: "Liefertermin gefährdet", color: "var(--bad)", items: late },
    { title: "Startet bald, nicht bereit", color: "var(--warn)", items: soon },
    { title: "Material fehlt laut Odoo", color: "var(--bad)", items: mat },
  ];
}

export function Alerts({ shared, onClose, onOpenPosition }) {
  const ref = useRef(null);
  const groups = shared ? alertsList(shared) : [];
  const n = groups.reduce((a, g) => a + g.items.length, 0);
  useEffect(() => {
    const out = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest("[data-alertbtn]")) onClose();
    };
    const t = setTimeout(() => document.addEventListener("click", out), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", out);
    };
  }, [onClose]);
  return (
    <div className="alerts" ref={ref} role="dialog" aria-label="Hinweise">
      <h4>
        Hinweise
        <span className={`pill ${n ? "bad" : "ok"}`}>{n ? `${n} offen` : "alles ruhig"}</span>
      </h4>
      <div className="body">
        {groups.map((g) =>
          g.items.length ? (
            <div key={g.title}>
              <div className="g">{g.title}</div>
              {g.items.map((i) => (
                <button className="it" type="button" key={g.title + i.id} onClick={() => onOpenPosition(i.id)}>
                  <i className="ic" style={{ background: g.color }} />
                  <div>
                    <b>{i.title}</b>
                    <span>{i.text}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : null
        )}
        {n === 0 && <div style={{ padding: "10px 16px 16px", color: "var(--muted)", fontSize: 13 }}>Es gibt zurzeit nichts, was Aufmerksamkeit braucht.</div>}
      </div>
    </div>
  );
}

// ---------- Talos: Antworten aus den Planungsdaten ----------
export const TSUG = ["Welche Aufträge verfehlen den Termin?", "Was fehlt noch bei ...?", "Wann ist die DMU frei?", "Wo fehlt Material?", "Was fällt im Dashboard auf?"];

function findPositions(t, pos) {
  const tokens = t.match(/[a-z]{1,4}-?\d{3,}/gi) || [];
  const hit = new Map();
  tokens.forEach((tk) => {
    const key = tk.toLowerCase();
    pos.forEach((p) => {
      if ((p.o.order_no || "").toLowerCase() === key || (p.source || "").toLowerCase() === key) hit.set(p.id, p);
    });
  });
  return [...hit.values()];
}

export function talosAnswer(q, shared) {
  const t = q.toLowerCase();
  const pos = shared?.positions || [];
  const fehlt = (p) => (p.av.open.length ? p.av.open.map((x) => x.label).join(", ") : null);
  const found = findPositions(t, pos);
  const mach = /dmu\s*-?50/.test(t) ? "dmu50" : /dmu/.test(t) ? "dmu40" : /\bm1\b/.test(t) ? "m1" : /h800|\bpos\b/.test(t) ? "h800u" : null;
  if (found.length) {
    const list = found.slice(0, 6);
    const text = list
      .map((p) => {
        let s = `${p.no} (${p.source}${p.product ? `, ${p.product}` : ""}): `;
        s += p.place ? `liegt auf ${p.place}${p.start ? `, Start ${fmtShort(p.start)}, Ende ca. ${fmtShort(p.end)}` : ""}` : "ist noch keiner Maschine zugeordnet";
        if (p.status === "late") s += `, voraussichtlich ${dayWord(p.lateDays)} nach dem Liefertermin`;
        else if (p.status && p.puffer != null) s += `, Puffer ${dayWord(Math.max(0, Math.floor(p.puffer)))}`;
        s += ". ";
        s += fehlt(p) ? `In der Arbeitsvorbereitung fehlt noch: ${fehlt(p)}.` : "Die Arbeitsvorbereitung ist abgeschlossen.";
        if (p.waitText) s += ` ${p.waitText}`;
        return s;
      })
      .join(" ");
    return { text, refs: list.map((p) => p.id) };
  }
  if (/frei/.test(t) && mach) {
    const mine = pos.filter((p) => p.machineId === mach && p.end);
    if (!mine.length) return { text: "Diese Maschine ist zurzeit frei, es ist nichts eingeplant.", refs: [] };
    const last = mine.reduce((a, b) => (b.endIdx > a.endIdx ? b : a));
    return { text: `${last.place} ist voraussichtlich ab ${fmtShort(last.end)} frei. Die letzte eingeplante Position ist ${last.no} (${last.source}).`, refs: [last.id] };
  }
  if (/termin|spät|gefähr|verfehl|rot/.test(t)) {
    const late = pos.filter((p) => p.status === "late");
    if (!late.length) return { text: "Zurzeit verfehlt kein Auftrag seinen Liefertermin.", refs: [] };
    const orders = [...new Set(late.map((p) => p.source))];
    return {
      text: `${orders.length} ${orders.length === 1 ? "Auftrag verfehlt" : "Aufträge verfehlen"} den Liefertermin: ${orders
        .slice(0, 6)
        .map((s) => {
          const p = late.find((x) => x.source === s);
          return `${s} um ${dayWord(p.lateDays)} (Liefertermin ${fmtShort(p.due)})`;
        })
        .join("; ")}.`,
      refs: orders.slice(0, 6).map((s) => late.find((x) => x.source === s).id),
    };
  }
  if (/material/.test(t)) {
    const open = pos.filter((p) => p.materialOpen || p.materialMissing);
    const nb = open.filter((p) => p.materialOpen);
    return {
      text: open.length
        ? `Bei ${open.length} Positionen ist das Material noch nicht da. ${nb.length} davon sind laut Arbeitsvorbereitung noch nicht bestellt${nb.length ? `: ${nb.slice(0, 6).map((p) => p.no).join(", ")}` : ""}.`
        : "Bei allen offenen Positionen ist das Material in Arbeit oder da.",
      refs: open.slice(0, 6).map((p) => p.id),
    };
  }
  if (/starten|bald|nicht bereit|fehlt/.test(t)) {
    const ur = pos.filter((p) => p.urgent);
    return {
      text: ur.length
        ? `${ur.length} Positionen starten in den nächsten 7 Tagen und sind noch nicht bereit. Am knappsten: ${ur.slice(0, 3).map((p) => `${p.no} (fehlt: ${fehlt(p)})`).join("; ")}.`
        : "Alles, was in den nächsten 7 Tagen startet, ist bereit.",
      refs: ur.slice(0, 6).map((p) => p.id),
    };
  }
  if (/dashboard|auslast|auffäll|auffall|kapazit|spindel/.test(t)) {
    const f = getDashFacts();
    if (!f) return { text: "Für das Dashboard gibt es noch keine Auswertung. Öffne die Seite Dashboard oder trage Zählerstände ein.", refs: [] };
    return { text: `In ${f.week} fällt auf: ${f.insights.length ? f.insights.map((i) => `${i.t} (${i.d})`).join(" ") : "nichts Besonderes."} Insgesamt liegt die Spindelauslastung bei ${f.spAll} % und die Kapazitätsauslastung bei ${f.capAll} %.`, refs: [] };
  }
  const src = t.match(/a\d{4,}/i);
  if (src) {
    const ks = pos.filter((p) => p.source.toLowerCase() === src[0].toLowerCase());
    if (ks.length) return { text: `${ks[0].source} hat ${ks.length} ${ks.length === 1 ? "Position" : "Positionen"}: ${ks.slice(0, 8).map((p) => `${p.no}${p.place ? ` auf ${p.place}` : " (nicht eingeplant)"}, AV ${p.av.ready ? "bereit" : "offen"}`).join("; ")}.`, refs: ks.slice(0, 8).map((p) => p.id) };
  }
  return { text: "Dazu habe ich in der Planung nichts Passendes gefunden. Die Anbindung an Talos mit Odoo und den anderen Systemen folgt, dann kann ich auch Kunden, Einkäufe und Lieferscheine abfragen. Probier eine der Fragen unten.", refs: [] };
}

// Talos-Bild (Spartaner); ohne Bild der Funke wie bisher
function TalosAvatar() {
  const [ok, setOk] = useState(true);
  return <span className="tavatar">{ok ? <img src="/talos.jpg" alt="" onError={() => setOk(false)} /> : <SparkIcon />}</span>;
}

// Antworttext mit einfachem Markdown: **fett**, [Titel](Link), Zeilenumbrüche
function TalosText({ text }) {
  const parts = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(m[1] ? <b key={m.index}>{m[1]}</b> : <a key={m.index} href={m[3]} target="_blank" rel="noreferrer">{m[2]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className="ttext">{parts}</span>;
}

function TalosPane({ shared, first, onBack, onOpenPosition }) {
  const [msgs, setMsgs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [val, setVal] = useState("");
  const boxRef = useRef(null);
  const inRef = useRef(null);
  const timers = useRef([]);
  const posById = useMemo(() => new Map((shared?.positions || []).map((p) => [p.id, p])), [shared]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const scroll = () => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  };
  const [local, setLocal] = useState(false); // Talos nicht erreichbar: Antworten nur aus der Planung
  // Fragt den echten Talos (Odoo, Wissensdatenbank, Planung, Postfächer); ohne Verbindung die Planungsantworten wie bisher
  // Antwort als Zeilenstrom: {"schritt"} während Talos arbeitet (onStep), am Ende {"antwort"} oder {"fehler"}
  const fetchAnswer = async (q, verlauf, onStep) => {
    try {
      const r = await fetch("/api/talos/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frage: q, verlauf, kontext: `Seite ${window.location.hash.replace(/^#/, "") || "planung"}` }),
      });
      if (r.ok && r.body) {
        setLocal(false);
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        let done = null;
        while (!done) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += value;
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            let ev;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.schritt) onStep(ev.schritt);
            if (ev.antwort || ev.fehler) done = ev;
          }
        }
        if (done?.antwort) {
          const refs = findPositions(done.antwort.toLowerCase(), shared?.positions || []).slice(0, 6).map((p) => p.id);
          return { text: done.antwort, refs };
        }
        return { text: done?.fehler || "Talos ist gerade nicht erreichbar.", refs: [] };
      }
      const d = await r.json().catch(() => ({}));
      if (r.status !== 503) return { text: d.error || "Talos ist gerade nicht erreichbar.", refs: [] };
    } catch {
      /* ohne Verbindung: Planungsantwort */
    }
    setLocal(true);
    return talosAnswer(q, shared);
  };
  const ask = async (q) => {
    q = (q || "").trim();
    if (!q || busy) return;
    setBusy(true);
    setVal("");
    const verlauf = msgs.filter((m) => !m.typing).map((m) => ({ rolle: m.me ? "nutzer" : "talos", text: m.full ?? m.text }));
    const idx = msgs.length;
    setMsgs((m) => [...m, { me: true, text: q }, { me: false, text: "", full: "", refs: [], typing: true }]);
    setTimeout(scroll, 0);
    const a = await fetchAnswer(q, verlauf, (step) => {
      setMsgs((m) => m.map((x, k) => (k === idx + 1 ? { ...x, step } : x)));
      scroll();
    });
    setMsgs((m) => m.map((x, k) => (k === idx + 1 ? { ...x, full: a.text, refs: a.refs } : x)));
    const fast = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const run = (i) => {
      // lange Antworten schneller schreiben (fertig nach etwa 2 Sekunden)
      i = fast ? a.text.length : Math.min(a.text.length, i + Math.max(2, Math.ceil(a.text.length / 120)));
      setMsgs((m) => m.map((x, k) => (k === idx + 1 ? { ...x, text: a.text.slice(0, i), typing: i < a.text.length } : x)));
      scroll();
      if (i < a.text.length) timers.current.push(setTimeout(() => run(i), 16));
      else {
        setBusy(false);
        setTimeout(() => inRef.current && inRef.current.focus(), 0);
      }
    };
    run(0);
  };
  useEffect(() => {
    if (first) ask(first);
    if (inRef.current) inRef.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="th">
        <TalosAvatar />
        <div className="tt">
          <b>Talos</b>
          <small>KI-Assistent von Kratos: Odoo, Wissensdatenbank, Planung, Einkauf</small>
        </div>
        <button className="back" type="button" onClick={onBack}>Zur Suche</button>
      </div>
      <div className="tmsgs" ref={boxRef} aria-live="polite">
        {msgs.map((m, i) =>
          m.me ? (
            <div className="msg me" key={i}><div className="bub">{m.text}</div></div>
          ) : (
            <div className="msg" key={i}>
              <TalosAvatar />
              <div className="bub">
                {m.text ? (
                  <TalosText text={m.text} />
                ) : (
                  <span className="tstep">
                    <span className="dots"><i /><i /><i /></span>
                    {m.step && <span key={m.step}>{m.step} …</span>}
                  </span>
                )}
                {m.typing && m.text && <span className="caret" />}
                {!m.typing && m.refs.length > 0 && (
                  <div className="refs">
                    {m.refs.map((id) => {
                      const p = posById.get(id);
                      return p ? (
                        <button className="ref" type="button" key={id} onClick={() => onOpenPosition(id)}>
                          <Thumb src={partImg(p.o)} size={24} />
                          {p.no}
                        </button>
                      ) : null;
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </div>
      <div className="tsug">
        {TSUG.filter((q) => !q.includes("...")).map((q) => (
          <button type="button" key={q} onClick={() => ask(q)}>{q}</button>
        ))}
      </div>
      <input
        className="tin"
        ref={inRef}
        type="text"
        placeholder="Nachfragen"
        autoComplete="off"
        aria-label="Frage an Talos"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            ask(val);
          }
        }}
      />
      <div className="foot">
        <span>{local ? "Talos nicht erreichbar: Antworten nur aus der Planung." : "Antworten mit Quellen. Talos ändert nichts, er schlägt nur vor."}</span>
        <span style={{ marginLeft: "auto" }}><kbd>Enter</kbd> senden · <kbd>Esc</kbd> schließen</span>
      </div>
    </>
  );
}

export function Palette({ shared, initialTalos, onClose, onOpenPosition, onGoPage }) {
  const [talos, setTalos] = useState(initialTalos);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inRef = useRef(null);
  useEffect(() => {
    if (!talos && inRef.current) inRef.current.focus();
  }, [talos]);

  const items = useMemo(() => {
    const raw = q.trim();
    const lq = raw.toLowerCase();
    const out = [];
    if (raw.length > 2) out.push({ t: "talos", q: raw, g: "Talos fragen" });
    else TSUG.filter((x) => !x.includes("...")).slice(0, 3).forEach((x) => out.push({ t: "talos", q: x, sug: true, g: "Fragen an Talos" }));
    const PCOL = { planung: "var(--slate)", av: "var(--teal)", dashboard: "var(--dmu)" };
    const PICO = { planung: "plan", av: "av", dashboard: "dash" };
    [["planung", "Produktionsplanung"], ["av", "Arbeitsvorbereitung"], ["dashboard", "Dashboard"]].forEach(([id, label]) => {
      if (!lq || label.toLowerCase().includes(lq)) out.push({ t: "page", id, label, col: PCOL[id], ic: PICO[id], g: "Seiten" });
    });
    const pos = shared?.positions || [];
    pos
      .filter((p) => !lq || `${p.no} ${p.source} ${p.product || ""}`.toLowerCase().includes(lq))
      .slice(0, lq ? 6 : 4)
      .forEach((p) => out.push({ t: "pos", p, g: "Positionen" }));
    return out;
  }, [q, shared]);
  const cur = Math.min(sel, Math.max(0, items.length - 1));
  const go = (i) => {
    const it = items[i];
    if (!it) return;
    if (it.t === "talos") setTalos(it.q);
    else if (it.t === "page") onGoPage(it.id);
    else onOpenPosition(it.p.id);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="pal-scrim" onClick={onClose} />
      <div className={`pal${talos ? " talos" : ""}`} role="dialog" aria-label="Schnellsuche">
        {talos ? (
          <TalosPane shared={shared} first={talos} onBack={() => setTalos(null)} onOpenPosition={onOpenPosition} />
        ) : (
          <>
            <div className="th">
              <AppTile size={34} color="var(--slate)"><Ico n="search" s={18} /></AppTile>
              <div className="tt">
                <b>Suche</b>
                <small>Positionen, Aufträge, Seiten und Fragen an Talos</small>
              </div>
            </div>
            <input
              ref={inRef}
              type="text"
              placeholder="Suchen oder Talos etwas fragen"
              autoComplete="off"
              aria-label="Suchen"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel(Math.min(items.length - 1, cur + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel(Math.max(0, cur - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  go(cur);
                }
              }}
            />
            <ul>
              {items.length === 0 && <li style={{ color: "var(--muted)", cursor: "default", padding: "14px 12px" }}>Nichts gefunden</li>}
              {items.map((it, i) => {
                const head = i === 0 || items[i - 1].g !== it.g;
                const on = i === cur ? "on" : "";
                return (
                  <React.Fragment key={i}>
                    {head && (
                      <li className="hd">
                        {/Talos/.test(it.g) && <SparkIcon s={13} />}
                        {it.g}
                      </li>
                    )}
                    {it.t === "talos" && (
                      <li className={`talos-item ${it.sug ? "sug " : ""}${on}`} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
                        <TalosAvatar />
                        <div className="t">
                          <b>{it.sug ? it.q : "Talos fragen"}</b>
                          <div>{it.sug ? "Frage an Talos, mit Quellen" : `"${it.q}"`}</div>
                        </div>
                        <kbd>Enter</kbd>
                      </li>
                    )}
                    {it.t === "page" && (
                      <li className={on} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
                        <AppTile size={34} color={it.col}><Ico n={it.ic} s={18} /></AppTile>
                        <div className="t">
                          <b style={{ fontFamily: "var(--f-body)", fontWeight: 600 }}>{it.label}</b>
                          <div>Seite öffnen</div>
                        </div>
                      </li>
                    )}
                    {it.t === "pos" && (
                      <li className={on} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
                        <Thumb src={partImg(it.p.o)} size={34} />
                        <div className="t">
                          <b>{it.p.no}</b>
                          <div>{it.p.source}{it.p.product ? ` · ${it.p.product}` : ""}</div>
                        </div>
                        {it.p.place ? (
                          <span className="pill mute"><i className="dot" style={{ "--c": it.p.placeColor }} />{it.p.place}</span>
                        ) : (
                          <span className="pill mute">nicht eingeplant</span>
                        )}
                      </li>
                    )}
                  </React.Fragment>
                );
              })}
            </ul>
            <div className="foot">
              <span><kbd>↑</kbd> <kbd>↓</kbd> wählen</span>
              <span><kbd>Enter</kbd> öffnen</span>
              <span><kbd>Esc</kbd> schließen</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
