// Freigaben: Die KI bereitet vor, ein Mensch prüft und gibt frei. Erst mit der Freigabe ändert sich etwas.
//
// Arten:
//   av      AV-Paket je neuem Fertigungsauftrag: Stunden (frühere Aufträge oder Kalkulation), Maschine, Material, Hinweise vom
//           Wiederholteil (Programm, Werkzeuge, Spannmittel), Plausibilitätsprüfung (z. B. Eloxieren bei Edelstahl).
//           Freigeben trägt die Stunden ein (nur wenn noch keine) und übernimmt die Hinweise in die AV-Punkte (nur leere Notizen).
//   plan    Morgenvorschlag: neue Positionen einplanen und die Reihenfolge verbessern (ohne Maschinenwechsel). Freigeben setzt den Plan
//           genau so, wie er vorgeschlagen wurde, aber nur, wenn sich die Planung seitdem nicht geändert hat.
//   hinweis Vorschlag oder Hinweis von Talos (Text). Freigeben heißt hier: gesehen, erledigt.
// Freigeben dürfen alle, die mit PIN angemeldet sind; festgehalten wird, wer wann was entschieden hat.
// Erstellt wird im Hintergrund (AV-Pakete alle 15 Minuten, Morgenvorschlag an Werktagen ab 6 Uhr) und auf Knopfdruck.
// In Odoo schreibt hier nichts, außer beim Freigeben eines Plans der bekannte Weg "Maschine im Arbeitsplan umstellen" (wie beim Ziehen).

import { loadPlanInputs, makeContext } from "./talosPlan.js";
import { planProposals } from "./planvorschlag.js";
import { reorderPlan, stampOf } from "./neuordnen.js";
import { kalkFromEnv, codeOf } from "./kalkClient.js";
import { programmHinweis } from "./programme.js";
import { basisOf } from "./sollIst.js";
import { zeichnungAbgleich } from "./zeichnung.js";
import { avKey, avSummary, AV_DEFAULT, AV_ITEMS } from "../src/avLib.js";
import { MACHINES, todayStr } from "../src/lib.js";
import { applyMove, byPosition, LANE_IDS } from "../src/planLogic.js";
import { staffName } from "../src/staffLib.js";

const MACHINE_IDS = MACHINES.map((m) => m.id);
const short = (id) => (MACHINES.find((m) => m.id === id) || {}).short || id;
const AV_EVERY = 15 * 60 * 1000;
const KALK_PER_RUN = 12;
const ZEICHNUNG_PER_RUN = 3; // Zeichnungen, die je Lauf (alle 15 min) neu gelesen werden (kostet je Zeichnung einige Cent)
const MORNING_HOUR = 6;
const NOTE_ITEMS = ["programm", "werkzeuge", "spannmittel"];
const h1 = (x) => String(Math.round(x * 10) / 10).replace(".", ",");

// Werkstoff grob einordnen (für die Plausibilität): Aluminium, Edelstahl, Stahl, Kunststoff
export function werkstoffArt(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (/edelstahl|\b1\.4\d{3}\b|v2a|v4a|x\d+cr|inox|aisi\s*3\d\d/.test(t)) return "edelstahl";
  if (/alu|almg|alzn|alsi|almgsi|en\s*aw|\b3\.\d{4}\b|\b[5-7]0[0-9]{2}\b/.test(t)) return "aluminium";
  if (/pom|pa6|peek|pe-hd|ptfe|kunststoff|delrin|pvc/.test(t)) return "kunststoff";
  if (/stahl|\b1\.[0-3]\d{3}\b|s235|s355|c45|42crmo4|16mncr5/.test(t)) return "stahl";
  return null;
}
const materialNote = (k) => [k.material ? `Werkstoff ${k.material}` : null, k.rawPart ? `Rohteil ${k.rawPart}` : null].filter(Boolean).join(", ") + " (laut Kalkulation)";

// Maschine aus einem Text der Kalkulation ("DMU 50", "DMG M1", "POS H800U" …)
export function machineFromText(text) {
  const raw = String(text || "").toLowerCase();
  const t = raw.replace(/\s+/g, "");
  if (!t) return null;
  if (t.includes("dmu40")) return "dmu40";
  if (t.includes("dmu50")) return "dmu50";
  if (t.includes("h800")) return "h800u";
  if (/(^|[^a-z0-9])m1([^0-9]|$)/.test(raw)) return "m1";
  return null;
}
// Plausibilität: Oberfläche passt nicht zum Werkstoff
export function plausibility({ werkstoff, oberflaechen }) {
  const art = werkstoffArt(werkstoff);
  const o = (oberflaechen || []).join(" ").toLowerCase();
  const out = [];
  if (/elox/.test(o) && art && art !== "aluminium") out.push(`Eloxieren geht nur bei Aluminium, der Werkstoff ist aber ${art === "edelstahl" ? "Edelstahl" : art === "stahl" ? "Stahl" : "Kunststoff"} (${werkstoff}).`);
  if (/brünier|bruenier|schwarz.?oxid/.test(o) && art && (art === "aluminium" || art === "edelstahl")) out.push(`Brünieren passt nicht zu ${art === "aluminium" ? "Aluminium" : "Edelstahl"} (${werkstoff}).`);
  if (/härt|haert|einsatzh/.test(o) && art === "aluminium") out.push(`Härten passt nicht zu Aluminium (${werkstoff}).`);
  return out;
}

export default function registerFreigaben(app, db, helpers) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS freigaben (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      art TEXT NOT NULL,
      schluessel TEXT UNIQUE,
      bezug TEXT,
      titel TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      daten TEXT NOT NULL DEFAULT '{}',
      quelle TEXT NOT NULL DEFAULT 'App',
      status TEXT NOT NULL DEFAULT 'offen',
      erstellt TEXT NOT NULL,
      geaendert TEXT,
      entschieden TEXT,
      von TEXT,
      notiz TEXT
    );
    CREATE INDEX IF NOT EXISTS freigaben_status ON freigaben (status);
  `);
  const kalk = helpers.kalk || kalkFromEnv();
  const now = () => new Date().toISOString();
  const rowOut = (r) => ({ ...r, daten: JSON.parse(r.daten || "{}") });
  const inputs = (today) => loadPlanInputs(db, helpers, today);
  const sessionOf = (req) => (app.locals.bdeSession ? app.locals.bdeSession(req) : null);
  const byKey = db.prepare("SELECT * FROM freigaben WHERE schluessel = ?");
  const insert = db.prepare("INSERT INTO freigaben (art, schluessel, bezug, titel, text, daten, quelle, status, erstellt) VALUES (?, ?, ?, ?, ?, ?, ?, 'offen', ?)");
  const updateOpen = db.prepare("UPDATE freigaben SET titel = ?, text = ?, daten = ?, geaendert = ? WHERE id = ? AND status = 'offen'");
  const setStatus = db.prepare("UPDATE freigaben SET status = ?, entschieden = ?, von = ?, notiz = ? WHERE id = ?");

  // Neu anlegen oder (wenn noch offen) aktualisieren; abgelehnte oder erledigte bleiben, wie sie sind
  function upsert({ art, schluessel, bezug = null, titel, text = "", daten = {}, quelle = "App" }) {
    const cur = schluessel ? byKey.get(schluessel) : null;
    const json = JSON.stringify(daten);
    if (cur) {
      if (cur.status === "offen" && (cur.daten !== json || cur.titel !== titel || cur.text !== text)) updateOpen.run(titel, text, json, now(), cur.id);
      return cur.id;
    }
    return Number(insert.run(art, schluessel, bezug, titel, text, json, quelle, now()).lastInsertRowid);
  }

  // ---------- AV-Paket ----------
  // Frühere erledigte Positionen desselben Teils: Notizen der AV (Programm, Werkzeuge, Spannmittel), zuletzt erledigte zuerst
  function repeatNotes(o) {
    if (!o.product) return null;
    const prev = db
      .prepare("SELECT id, order_no, odoo_ref, done_date FROM orders WHERE done = 1 AND product = ? AND id != ? ORDER BY COALESCE(done_date, '') DESC, id DESC LIMIT 5")
      .all(o.product, o.id);
    const notes = db.prepare("SELECT item, note, status FROM av_checks WHERE order_id = ? AND note != ''");
    for (const p of prev) {
      const list = notes.all(p.id).filter((n) => NOTE_ITEMS.includes(n.item) && n.note.trim());
      if (list.length) return { from: p.odoo_ref || p.order_no, notes: Object.fromEntries(list.map((n) => [n.item, n.note.trim()])) };
    }
    return prev.length ? { from: prev[0].odoo_ref || prev[0].order_no, notes: {} } : null;
  }
  // Wiederholteil: Waren Werkzeuge/Spannmittel beim letzten erledigten Auftrag desselben Teils bereit, ist es diesmal vermutlich dasselbe
  function repeatReady(o) {
    if (!o.product) return null;
    const prev = db.prepare("SELECT id, order_no, odoo_ref FROM orders WHERE done = 1 AND product = ? AND id != ? ORDER BY COALESCE(done_date, '') DESC, id DESC LIMIT 1").get(o.product, o.id);
    if (!prev) return null;
    const rows = db.prepare("SELECT item, status FROM av_checks WHERE order_id = ? AND item IN ('werkzeuge', 'spannmittel') AND status = 'bereit'").all(prev.id);
    return rows.length ? { from: prev.odoo_ref || prev.order_no, items: rows.map((r) => r.item) } : null;
  }

  // Oberflächen-/Fremdarbeitsgänge laut Odoo-Arbeitsplan (für die Plausibilität)
  const woCache = new Map(); // Odoo-Fertigungsauftrag -> { at, names }
  async function surfacesOf(o) {
    const out = [...(o.extern_tags || [])];
    const read = app.locals.odooRead;
    if (read && o.odoo_id) {
      const hit = woCache.get(o.odoo_id);
      if (hit && Date.now() - hit.at < 6 * 3600 * 1000) out.push(...hit.names);
      else
        try {
          const wos = await read("mrp.workorder", { domain: [["production_id", "=", o.odoo_id], ["state", "!=", "cancel"]], fields: ["name", "workcenter_id"], limit: 40 });
          const names = wos.flatMap((w) => [String(w.name || ""), Array.isArray(w.workcenter_id) ? String(w.workcenter_id[1]) : ""]);
          woCache.set(o.odoo_id, { at: Date.now(), names });
          out.push(...names);
        } catch {
          /* ohne Arbeitsplan weiter */
        }
    }
    return [...new Set(out.filter((s) => /elox|brünier|bruenier|härt|haert|pulver|beschicht|vernick|verzink|oberfläche|strahl|schleif/i.test(s)))];
  }

  async function buildPaket(o, kalkLeft, checks, zLeft = { n: 0 }) {
    const qty = Number(o.quantity) || 1;
    const code = codeOf(o.product);
    let k = null;
    // je Lauf nur wenige neue Abfragen an die Kalkulation, schon bekannte kommen aus dem Zwischenspeicher
    if (code && kalk.enabled && (kalk.isCached(code, qty) || kalkLeft.n-- > 0)) {
      try {
        k = await kalk.lookup(code, qty);
      } catch (err) {
        k = { known: false, error: err.message };
      }
    }
    const rep = repeatNotes(o);
    const surfaces = await surfacesOf(o);
    // Werkstoff aus der Kalkulation, sonst aus dem Produktnamen (wenn dort einer steht)
    // Zeichnung (PDF aus Odoo, von Talos gelesen): gespeichert oder, wenn noch nie gelesen, im Hintergrund (wenige je Lauf)
    const fa = o.odoo_ref || o.parent_ref || "";
    const zs = app.locals.zeichnung;
    let z = null;
    if (zs && zs.enabled && /^FA\d/.test(fa)) {
      z = zs.gespeichert(fa);
      if (!z && zLeft.n > 0) {
        zLeft.n--;
        try {
          z = await zs.lesen(fa);
        } catch (err) {
          z = { grund: err.message, daten: null };
        }
      }
    }
    const zd = z && z.daten ? z.daten : null;
    // Werkstoff: Zeichnung vor Kalkulation vor Produktname
    const werkstoff = zd && zd.werkstoff ? zd.werkstoff : k && k.material ? k.material : werkstoffArt(o.product) ? o.product : "";
    const verlangt = zd ? [...(zd.oberflaeche || []), zd.waermebehandlung || ""].filter(Boolean) : [];
    const warnungen = plausibility({ werkstoff, oberflaechen: [...surfaces, ...verlangt] });
    const abgleich = zeichnungAbgleich(zd, { oberflaechenArbeitsplan: surfaces, kalkWerkstoff: (k && k.material) || "", werkstoffArtOf: werkstoffArt });
    warnungen.push(...abgleich.warnungen);
    // Stunden: vorhandene bleiben; sonst frühere Aufträge (echte Zeiten), sonst Kalkulation
    let hours = null;
    let hoursSrc = null;
    if (!(o.hours > 0)) {
      if (o.hours_suggest > 0) {
        hours = o.hours_suggest;
        hoursSrc = o.hours_suggest_src || "aus früheren Aufträgen";
      } else if (k && k.known && k.hours > 0) {
        hours = k.hours;
        hoursSrc = `aus der Kalkulation (${k.basis || "Schätzung"}${k.confidence ? ", Sicherheit " + k.confidence : ""}): Rüsten ${h1(k.setupMin / 60)} h, Fräsen ${h1(k.perPieceMin)} min je Stück`;
        // gelernt aus Soll/Ist: liegt die Kalkulation auf dieser Maschine regelmäßig daneben, korrigieren
        const mid = MACHINE_IDS.includes(o.odoo_machine) ? o.odoo_machine : machineFromText(k.machine);
        const f = app.locals.sollIst ? app.locals.sollIst.faktor("kalkulation", mid) : null;
        if (f && Math.abs(f.faktor - 1) >= 0.1) {
          const raw = hours;
          hours = Math.max(0.5, Math.ceil(raw * f.faktor * 2) / 2);
          hoursSrc += `; korrigiert ${h1(raw)} → ${h1(hours)} h, weil die Kalkulation ${f.machine ? "auf der " + f.maschine : ""} bei ${f.n} erledigten Aufträgen im Mittel ${Math.round(Math.abs(f.faktor - 1) * 100)} % zu ${f.faktor > 1 ? "niedrig" : "hoch"} lag`;
        }
      }
    }
    const kalkMachine = k ? machineFromText(k.machine) : null;
    const machine = MACHINE_IDS.includes(o.odoo_machine) ? { id: o.odoo_machine, why: "laut Odoo-Arbeitsplan" } : kalkMachine ? { id: kalkMachine, why: "laut Kalkulation" } : null;
    const notes = {};
    if (rep && rep.notes) for (const it of NOTE_ITEMS) if (rep.notes[it]) notes[it] = `${rep.notes[it]} (wie ${rep.from})`;
    if (!notes.programm && k && k.reference && k.reference.type === "repeat") notes.programm = `Wiederholteil laut Kalkulation (${k.reference.part}${k.reference.order ? ", " + k.reference.order : ""}): Programm vermutlich vorhanden`;
    if (zd && zd.werkstoff) notes.material = `Werkstoff ${zd.werkstoff} (Zeichnung${zd.index ? ", Index " + zd.index : ""})${k && k.rawPart ? ", Rohteil " + k.rawPart + " (Kalkulation)" : ""}`;
    if (!notes.material && k && (k.material || k.rawPart)) notes.material = materialNote(k);
    // Mastercam-Programm im Auftragsordner (gemeldet von auftragsordner/programme_melden.py) geht vor allen anderen Hinweisen
    const status = {};
    const prog = app.locals.programmOf ? programmHinweis(app.locals.programmOf(o.odoo_ref || o.parent_ref)) : null;
    if (prog) {
      notes.programm = prog.text;
      if (prog.status) status.programm = prog.status;
    }
    const rr = repeatReady(o);
    if (rr) for (const it of rr.items) {
      status[it] = "bereit";
      if (!notes[it]) notes[it] = `wie bei ${rr.from} (Wiederholteil)`;
    }
    // nur vorschlagen, wo die AV noch nichts notiert hat und der Punkt nicht schon erledigt ist
    for (const it of Object.keys(notes)) {
      const c = checks && checks.get(avKey(o.id, it));
      if (c && ((c.note && c.note.trim()) || c.status === "bereit" || c.status === "entfaellt")) delete notes[it];
    }
    for (const it of Object.keys(status)) {
      const c = checks && checks.get(avKey(o.id, it));
      if (c && (c.status === "bereit" || c.status === "entfaellt")) delete status[it];
    }
    const hinweise = [];
    hinweise.push(...abgleich.hinweise);
    if (zd && zd.werkstoff && !notes.material) hinweise.push(`Werkstoff laut Zeichnung: ${zd.werkstoff}${zd.index ? " (Index " + zd.index + ")" : ""}`);
    if (o.odoo_draft) hinweise.push("Fertigungsauftrag in Odoo noch im Entwurf: nach der AV dort bestätigen");
    if (o.odoo_bom === "muster") hinweise.push("Stückliste läuft auf Musterwerten: Maschine und Zeit in Odoo prüfen");
    if (/noch nicht bestellt/.test(o.material_info || "")) hinweise.push("Material: nur Anfrage in Odoo, klären");
    if (!(o.hours > 0) && !hours) hinweise.push(code && kalk.enabled && !(k && k.known) ? "Noch nicht kalkuliert: „In der Kalkulation berechnen“ liefert Zeiten" : "Keine Zeiten ermittelbar: Stunden bitte schätzen");
    return {
      orderId: o.id,
      odooId: o.odoo_id || null,
      ref: o.odoo_ref || o.order_no,
      source: o.source || null,
      product: o.product || null,
      quantity: o.quantity ?? null,
      due: o.due || null,
      hours,
      hoursSrc,
      machine,
      material: o.material_info || null,
      werkstoff: (zd && zd.werkstoff) || (k && k.material) || null,
      zeichnung: z ? { anhang: z.anhang || null, nummer: zd ? zd.zeichnungsnummer || null : null, index: zd ? zd.index || null : null, sicherheit: zd ? zd.sicherheit : null, grund: z.grund || null, abmessungen: zd ? zd.abmessungen || null : null } : null,
      rohteil: (k && k.rawPart) || null,
      programmingMin: (k && k.programmingMin) || null,
      kalkLink: (k && k.link) || null,
      kalkProductId: (k && k.productId) || null,
      kalkBekannt: !!(k && k.known),
      kalkMoeglich: !!(code && kalk.enabled && !(k && k.known)),
      kalkFehler: (k && k.error) || null,
      wiederholteil: rep ? rep.from : null,
      notes,
      status,
      oberflaechen: surfaces,
      warnungen,
      hinweise,
    };
  }

  // Ein Paket lohnt sich nur, wenn es etwas Neues bringt: Stunden für eine Position ohne Stunden, Hinweise für leere AV-Punkte
  // oder eine Warnung. Positionen ohne Stunden bekommen immer eines (dort fehlt das Wichtigste).
  const isPaketWorth = (p, o) => !(o.hours > 0) || Object.keys(p.notes).length > 0 || Object.keys(p.status || {}).length > 0 || p.warnungen.length > 0;

  async function prepareAv() {
    const inp = inputs();
    // ohne Stunden zuerst (die brauchen die Kalkulation am dringendsten), dann nach Liefertermin
    const open = inp.orders
      // ohne Nummer und ohne Odoo-Bezug (leere Karte) gibt es nichts vorzubereiten
      .filter((o) => !o.done && !LANE_IDS.includes(o.machine) && !o.is_split && (String(o.order_no || "").trim() || o.odoo_ref))
      .sort((a, b) => (a.hours > 0) - (b.hours > 0) || (a.due || "9999").localeCompare(b.due || "9999") || a.id - b.id);
    const kalkLeft = { n: KALK_PER_RUN };
    const zLeft = { n: process.env.ZEICHNUNG_AUTO === "0" ? 0 : ZEICHNUNG_PER_RUN };
    let made = 0;
    for (const o of open) {
      const key = "av:" + o.id;
      const cur = byKey.get(key);
      if (cur && cur.status !== "offen") continue;
      const s = avSummary(inp.checks, o.id);
      if (s.ready && o.hours > 0) {
        // AV ist schon fertig: ein offenes Paket hat sich erledigt
        if (cur) setStatus.run("hinfaellig", now(), "App", "AV inzwischen fertig", cur.id);
        continue;
      }
      const p = await buildPaket(o, kalkLeft, inp.checks, zLeft);
      if (!isPaketWorth(p, o)) {
        if (cur) setStatus.run("hinfaellig", now(), "App", "nichts mehr vorzuschlagen", cur.id);
        continue;
      }
      p.kategorie = kategorieOf(p);
      const fid = upsert({
        art: "av",
        schluessel: key,
        bezug: o.odoo_ref || o.order_no,
        titel: `AV-Paket ${o.odoo_ref || o.order_no}${o.source ? " · " + o.source : ""}`,
        text: [p.hours ? `${h1(p.hours)} h` : null, p.machine ? short(p.machine.id) : null, p.warnungen.length ? `${p.warnungen.length} Warnung` : null].filter(Boolean).join(" · "),
        daten: p,
      });
      made++;
      await autopilot(fid, p.kategorie);
    }
    // Pakete zu erledigten oder verschwundenen Positionen schließen
    const alive = new Set(open.map((o) => "av:" + o.id));
    db.prepare("SELECT id, schluessel FROM freigaben WHERE art = 'av' AND status = 'offen'")
      .all()
      .forEach((r) => !alive.has(r.schluessel) && setStatus.run("hinfaellig", now(), "App", "Position erledigt oder nicht mehr in der AV", r.id));
    return made;
  }

  function applyAv(f) {
    const p = f.daten;
    const o = db.prepare("SELECT id, hours, done FROM orders WHERE id = ?").get(p.orderId);
    if (!o || o.done) throw Object.assign(new Error("Die Position ist schon erledigt."), { status: 409 });
    const done = [];
    if (p.hours > 0 && !(o.hours > 0)) {
      db.prepare("UPDATE orders SET hours = ?, hours_plan = ?, hours_basis = ? WHERE id = ?").run(p.hours, p.hours, p.hoursBasis || basisOf(p.hoursSrc), o.id);
      done.push(`${h1(p.hours)} h eingetragen`);
    }
    const cur = db.prepare("SELECT status, note FROM av_checks WHERE order_id = ? AND item = ?");
    const put = db.prepare(
      `INSERT INTO av_checks (order_id, item, status, due, note, assignee, updated_at, auto) VALUES (?, ?, ?, NULL, ?, NULL, datetime('now'), 0)
       ON CONFLICT (order_id, item) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`
    );
    for (const [item, text] of Object.entries(p.notes || {})) {
      if (!AV_ITEMS.some((x) => x.id === item)) continue;
      const c = cur.get(o.id, item);
      if (c && c.note && c.note.trim()) continue; // vorhandene Notizen nie überschreiben
      put.run(o.id, item, AV_DEFAULT[item] || "offen", String(text).slice(0, 300));
      done.push(`Hinweis ${AV_ITEMS.find((x) => x.id === item).label}`);
    }
    // Status-Vorschläge (z. B. Programm liegt im Auftragsordner -> bereit), nur wenn der Punkt noch offen ist
    const setSt = db.prepare(
      `INSERT INTO av_checks (order_id, item, status, due, note, assignee, updated_at, auto) VALUES (?, ?, ?, NULL, '', NULL, datetime('now'), 0)
       ON CONFLICT (order_id, item) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
    );
    for (const [item, st] of Object.entries(p.status || {})) {
      if (!AV_ITEMS.some((x) => x.id === item)) continue;
      const c = cur.get(o.id, item);
      if (c && c.status !== "offen" && c.status !== AV_DEFAULT[item]) continue;
      setSt.run(o.id, item, st);
      done.push(`${AV_ITEMS.find((x) => x.id === item).label} auf ${st}`);
    }
    // Kalkulation rechnet das Teil auf der M1: dann passt es dort (Planung darf es auf die M1 legen)
    if (p.machine && p.machine.id === "m1" && p.machine.why === "laut Kalkulation") {
      db.prepare("UPDATE orders SET restricted_ok = 1 WHERE id = ?").run(o.id);
      done.push("passt auf M1");
    }
    return done.length ? done.join(", ") : "nichts zu übernehmen (Stunden und Notizen waren schon da)";
  }

  // ---------- Morgenvorschlag (Plan) ----------
  // Positionen einplanen wie vorgeschlagen und danach die Reihenfolge verbessern; Ergebnis = Reihenfolge je Maschine
  function planPreview(inp) {
    const pv = planProposals(inp);
    let work = inp.orders;
    for (const p of pv.vorschlaege) {
      const q = work.filter((x) => x.machine === p.machine && !x.done && x.id !== p.id).sort(byPosition);
      const at = p.beforeId != null ? q.findIndex((x) => x.id === p.beforeId) : -1;
      work = applyMove(work, [p.id], p.machine, at < 0 ? q.length : at).orders;
    }
    const ro = reorderPlan({ ...inp, orders: work }, { wechseln: false });
    const final = new Map();
    MACHINE_IDS.forEach((mid) => final.set(mid, work.filter((x) => x.machine === mid && !x.done).sort(byPosition).map((x) => x.id)));
    if (ro.verbessert) ro.maschinen.forEach((m) => final.set(m.id, m.ids));
    const ctx = makeContext(inp);
    const late = (orders) => ctx.compute(orders).groups.filter((g) => g.status === "late");
    const finalOrders = inp.orders.map((o) => {
      for (const [mid, ids] of final) {
        const i = ids.indexOf(o.id);
        if (i >= 0) return { ...o, machine: mid, position: i };
      }
      return o;
    });
    const before = late(inp.orders);
    const mid = late(work); // nur eingeplant, noch nicht umgestellt
    const after = late(finalOrders);
    const sum = (gs) => ({ zuSpaet: gs.length, tage: gs.reduce((x, g) => x + (g.lateDays || 0), 0) });
    // Welche Positionen ändern sich (für die Vorschau im Zeitstrahl)
    const geaendert = new Set(pv.vorschlaege.map((p) => p.id));
    if (ro.verbessert) ro.maschinen.forEach((m) => m.items.forEach((x) => (x.vonPlatz !== x.platz || x.vonMaschine) && geaendert.add(x.id)));
    return {
      stamp: stampOf(inp.orders),
      einplanen: pv.vorschlaege.map((p) => ({ id: p.id, ref: p.ref, source: p.source, customer: p.customer, machine: p.machine, machineName: p.machineName, platz: p.platz, start: p.start, ende: p.ende, status: p.status, lateDays: p.lateDays, basis: p.basis })),
      ohneStunden: pv.ohneStunden.length,
      umordnen: ro.verbessert ? ro.auftraege.slice(0, 12) : [],
      umgestellt: ro.verbessert ? ro.maschinen.reduce((s, m) => s + m.items.filter((x) => x.vonPlatz !== x.platz || x.vonMaschine).length, 0) : 0,
      vorher: sum(before),
      nachEinplanen: sum(mid),
      nachher: sum(after),
      // neu eingeplante Positionen, deren Auftrag schon jetzt zu spät ist (waren vorher nur nicht sichtbar)
      schonSpaet: pv.vorschlaege.filter((p) => p.status === "late").map((p) => ({ id: p.id, ref: p.ref, source: p.source, lateDays: p.lateDays })),
      geaendertIds: [...geaendert],
      reihenfolge: Object.fromEntries(final),
    };
  }

  // Kurzer Text ohne KI (falls Talos nicht erreichbar ist)
  function ruleText(pr, heute) {
    const lines = [];
    if (pr.einplanen.length) {
      const spaet = pr.schonSpaet || [];
      lines.push(`${pr.einplanen.length} ${pr.einplanen.length === 1 ? "Position" : "Positionen"} neu einplanen, ${pr.einplanen.length - spaet.length} davon pünktlich.`);
      if (spaet.length) lines.push(`Schon zu spät (waren bisher nur nicht eingeplant): ${[...new Set(spaet.map((x) => x.source || x.ref))].join(", ")}.`);
    }
    if (pr.umgestellt) {
      const a = pr.nachEinplanen || pr.vorher;
      const gewinn = a.tage - pr.nachher.tage;
      lines.push(`${pr.umgestellt} ${pr.umgestellt === 1 ? "Position" : "Positionen"} umstellen: ${gewinn > 0 ? `spart ${gewinn} Verspätungstage` : "gleich viele Verspätungstage"}${a.zuSpaet > pr.nachher.zuSpaet ? `, ${a.zuSpaet - pr.nachher.zuSpaet} Aufträge weniger zu spät` : ""}.`);
    }
    if (pr.ohneStunden) lines.push(`${pr.ohneStunden} ${pr.ohneStunden === 1 ? "Position hat" : "Positionen haben"} noch keine Stunden: AV-Pakete prüfen.`);
    (heute || []).filter((i) => i.tone === "bad").forEach((i) => lines.push(`${i.n} ${i.text.replace(/^\d+\s/, "")}.`));
    return lines.join("\n");
  }

  // Talos schreibt die Zusammenfassung mit Begründung (wenn eingerichtet). Ohne Antwort bleibt der Regeltext.
  async function talosText(pr, id) {
    const URL = process.env.TALOS_URL || "https://odoo-mcp.kratos-precision.de/talos/ask";
    const KEY = process.env.TALOS_KEY_DASHBOARD || "";
    if (KEY.length < 24) return;
    const frage =
      "Morgenlauf Produktionsplanung. Lies plan_heute und plan_vorschlag und schreib Frank in höchstens 8 kurzen Punkten: was heute zuerst zu tun ist, " +
      "welche Kunden wegen Verzug informiert werden müssen, was der Planvorschlag ändert und warum, und wo du ein Risiko siehst. Nur Fakten aus den Werkzeugen. Keine Quellenliste.";
    try {
      const r = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ frage, verlauf: [], absender: { name: "Morgenlauf (Produktionsdashboard)", rolle: "System" }, kontext: `Vorschlag: ${pr.einplanen.length} einplanen, ${pr.umgestellt} umstellen` }),
        signal: AbortSignal.timeout(240000),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.antwort) {
        const cur = db.prepare("SELECT status, daten FROM freigaben WHERE id = ?").get(id);
        if (cur && cur.status === "offen") db.prepare("UPDATE freigaben SET text = ?, quelle = 'Talos', geaendert = ? WHERE id = ?").run(String(d.antwort).slice(0, 4000), now(), id);
      }
    } catch (err) {
      console.error("Morgenlauf: Talos nicht erreichbar", err.message);
    }
  }

  // Ein Planvorschlag je Tag. Neu vorbereiten aktualisiert den offenen; ist der heutige schon entschieden, kommt ein neuer dazu.
  function preparePlan({ force = false, talos = true } = {}) {
    const today = todayStr();
    const inp = inputs(today);
    const key = "plan:" + today;
    const cur = byKey.get(key);
    if (cur && cur.status !== "offen") {
      if (!force) return cur.id;
      db.prepare("UPDATE freigaben SET schluessel = ? WHERE id = ?").run(key + ":" + cur.id, cur.id);
    }
    // ältere offene Planvorschläge (von gestern) sind überholt
    db.prepare("SELECT id FROM freigaben WHERE art = 'plan' AND status = 'offen' AND schluessel != ?")
      .all(key)
      .forEach((r) => setStatus.run("hinfaellig", now(), "App", "durch neueren Vorschlag ersetzt", r.id));
    const pr = planPreview(inp);
    let heute = [];
    try {
      heute = app.locals.heuteListe ? app.locals.heuteListe().items : [];
    } catch {
      /* ohne Heute-Liste weiter */
    }
    const nothing = !pr.einplanen.length && !pr.umgestellt;
    const titel = nothing ? "Morgenbericht: am Plan ist nichts zu ändern" : `Planvorschlag für heute: ${pr.einplanen.length} einplanen, ${pr.umgestellt} umstellen`;
    // Autopilot nur, wenn keine neu eingeplante Position zu spät ist und das Umstellen nichts verschlechtert
    pr.kategorie = !nothing && !pr.schonSpaet.length && pr.nachher.zuSpaet <= pr.nachEinplanen.zuSpaet && pr.nachher.tage <= pr.nachEinplanen.tage ? "plan" : null;
    const id = upsert({ art: "plan", schluessel: key, bezug: today, titel, text: ruleText(pr, heute), daten: pr });
    if (talos) talosText(pr, id);
    if (pr.kategorie && autoOn(pr.kategorie)) autopilot(id, pr.kategorie).catch((err) => console.error("Autopilot Plan:", err.message));
    return id;
  }

  function applyPlan(f) {
    const p = f.daten;
    const inp = inputs();
    if (stampOf(inp.orders) !== p.stamp) {
      // Seit dem Vorschlag hat sich etwas geändert (Stempeln, Odoo-Abgleich, jemand hat gezogen): Vorschlag neu rechnen, nichts übernehmen
      preparePlan({ force: true, talos: false });
      throw Object.assign(new Error("Die Planung hat sich seit dem Vorschlag geändert. Der Vorschlag ist neu gerechnet, bitte noch einmal ansehen und freigeben."), { status: 409 });
    }
    const before = new Map(db.prepare("SELECT id, machine, odoo_id, odoo_ref, done FROM orders WHERE done = 0").all().map((r) => [r.id, r]));
    const upd = db.prepare("UPDATE orders SET machine = ?, position = ? WHERE id = ? AND done = 0");
    const moved = new Map();
    db.exec("BEGIN");
    try {
      for (const [mid, ids] of Object.entries(p.reihenfolge || {})) {
        if (!MACHINE_IDS.includes(mid)) continue;
        ids.forEach((id, i) => {
          const b = before.get(id);
          if (!b) return;
          if (b.machine !== mid) {
            if (!moved.has(mid)) moved.set(mid, []);
            moved.get(mid).push(b);
          }
          upd.run(mid, i, id);
        });
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return moved;
  }

  // ---------- Autopilot ----------
  // Arten von Vorschlägen, die die App selbst freigeben darf, wenn die Leitung es einschaltet. Einschalten geht nur, wenn Menschen diese Art
  // in den letzten 90 Tagen mindestens AUTO_MIN_N-mal entschieden und mindestens AUTO_QUOTE % davon unverändert freigegeben haben.
  // Mit Warnung (z. B. Eloxieren bei Edelstahl) gibt der Autopilot nie frei. Im Verlauf steht "Autopilot".
  const AUTO_MIN_N = 10;
  const AUTO_QUOTE = 90;
  const KATEGORIEN = [
    { id: "av_historie", label: "AV-Pakete mit Stunden aus früheren Aufträgen", beschreibung: "Wiederholteil: echte gestempelte Zeiten, keine Warnung" },
    { id: "av_kalk_ist", label: "AV-Pakete mit Stunden aus der Kalkulation (Ist-Zeiten)", beschreibung: "Kalkulation rechnet mit Ist-Zeiten eines Wiederholteils, keine Warnung" },
    { id: "av_hinweise", label: "AV-Pakete nur mit Hinweisen", beschreibung: "Stunden stehen schon; Programm, Werkstoff, Hinweise vom Wiederholteil, keine Warnung" },
    { id: "plan", label: "Planvorschlag am Morgen", beschreibung: "nur wenn danach nicht mehr Aufträge zu spät sind als vorher" },
  ];
  db.exec("CREATE TABLE IF NOT EXISTS autopilot (kategorie TEXT PRIMARY KEY, an INTEGER NOT NULL DEFAULT 0, von TEXT, geaendert TEXT)");
  function kategorieOf(p) {
    if ((p.warnungen || []).length) return null;
    if (p.hours > 0 && /aus der Kalkulation \(Wiederholteil/.test(p.hoursSrc || "") && !/korrigiert/.test(p.hoursSrc || "")) return "av_kalk_ist";
    if (p.hours > 0 && !/Kalkulation/.test(p.hoursSrc || "")) return "av_historie";
    if (!p.hours && (Object.keys(p.notes || {}).length || Object.keys(p.status || {}).length) && !(p.hinweise || []).some((h) => /Keine Zeiten|kalkuliert/.test(h))) return "av_hinweise";
    return null;
  }
  const autoOn = (k) => !!(k && (db.prepare("SELECT an FROM autopilot WHERE kategorie = ?").get(k) || {}).an);
  function quoteOf(k) {
    const r = db
      .prepare(
        `SELECT SUM(status = 'freigegeben') AS ja, SUM(status = 'abgelehnt') AS nein FROM freigaben
         WHERE json_extract(daten, '$.kategorie') = ? AND status IN ('freigegeben', 'abgelehnt') AND COALESCE(von, '') != 'Autopilot' AND erstellt >= ?`
      )
      .get(k, new Date(Date.now() - 90 * 86400000).toISOString());
    const n = (r.ja || 0) + (r.nein || 0);
    return { n, quote: n ? Math.round(((r.ja || 0) / n) * 100) : null };
  }
  async function autopilot(id, k) {
    if (!autoOn(k)) return;
    const f = db.prepare("SELECT status FROM freigaben WHERE id = ?").get(id);
    if (!f || f.status !== "offen") return;
    try {
      await decide(id, "freigeben", "automatisch freigegeben", "Autopilot");
    } catch (err) {
      console.error("Autopilot:", err.message);
    }
  }
  app.get("/api/autopilot", (req, res) =>
    res.json({
      minN: AUTO_MIN_N,
      minQuote: AUTO_QUOTE,
      kategorien: KATEGORIEN.map((k) => {
        const q = quoteOf(k.id);
        const row = db.prepare("SELECT * FROM autopilot WHERE kategorie = ?").get(k.id) || {};
        const auto = db.prepare("SELECT COUNT(*) AS n FROM freigaben WHERE json_extract(daten, '$.kategorie') = ? AND von = 'Autopilot'").get(k.id).n;
        const moeglich = q.n >= AUTO_MIN_N && q.quote >= AUTO_QUOTE;
        return { ...k, an: !!row.an, von: row.von || null, geaendert: row.geaendert || null, ...q, automatisch: auto, moeglich, grund: moeglich ? null : q.n < AUTO_MIN_N ? `erst ${q.n} von ${AUTO_MIN_N} Entscheidungen` : `nur ${q.quote} % unverändert freigegeben (nötig ${AUTO_QUOTE} %)` };
      }),
    })
  );
  app.post("/api/autopilot", (req, res) => {
    const s = sessionOf(req);
    if (!s || !s.leitung) return res.status(403).json({ error: "Den Autopilot kann nur die Leitung (PIN) ein- oder ausschalten." });
    const k = KATEGORIEN.find((x) => x.id === (req.body && req.body.kategorie));
    if (!k) return res.status(400).json({ error: "kategorie unbekannt" });
    const an = !!(req.body && req.body.an);
    if (an) {
      const q = quoteOf(k.id);
      if (q.n < AUTO_MIN_N || q.quote < AUTO_QUOTE) return res.status(409).json({ error: `Noch nicht sicher genug: ${q.n} Entscheidungen, ${q.quote ?? 0} % unverändert freigegeben (nötig ${AUTO_MIN_N} und ${AUTO_QUOTE} %).` });
    }
    db.prepare("INSERT INTO autopilot (kategorie, an, von, geaendert) VALUES (?, ?, ?, ?) ON CONFLICT (kategorie) DO UPDATE SET an = excluded.an, von = excluded.von, geaendert = excluded.geaendert").run(k.id, an ? 1 : 0, staffName(s.e) || `Mitarbeiter ${s.e}`, now());
    res.json({ ok: true, kategorie: k.id, an });
  });

  // ---------- API ----------
  app.get("/api/freigaben", (req, res) => {
    const status = req.query.status === "alle" ? null : "offen";
    const rows = status
      ? db.prepare("SELECT * FROM freigaben WHERE status = 'offen' ORDER BY CASE art WHEN 'plan' THEN 0 WHEN 'hinweis' THEN 1 ELSE 2 END, erstellt DESC").all()
      : db.prepare("SELECT * FROM freigaben ORDER BY erstellt DESC LIMIT 200").all();
    res.json({ items: rows.map(rowOut), kalkulation: kalk.enabled });
  });

  // Auf Knopfdruck: AV-Pakete und Morgenvorschlag neu vorbereiten
  app.post("/api/freigaben/vorbereiten", async (req, res) => {
    try {
      const av = await prepareAv();
      const plan = preparePlan({ force: true });
      res.json({ ok: true, av, plan });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Entscheiden: freigeben oder ablehnen (angemeldet mit PIN)
  // Entscheiden (Browser mit PIN oder Chat-Planung): freigeben führt aus, ablehnen merkt sich die Begründung
  const fail = (status, message) => Object.assign(new Error(message), { status });
  async function decide(id, aktion, notiz, who) {
    const f = db.prepare("SELECT * FROM freigaben WHERE id = ?").get(Number(id));
    if (!f) throw fail(404, "Nicht gefunden");
    if (f.status !== "offen") throw fail(409, "Darüber ist schon entschieden.");
    notiz = String(notiz || "").slice(0, 300);
    if (aktion === "ablehnen") {
      setStatus.run("abgelehnt", now(), who, notiz || null, f.id);
      return { ok: true, status: "abgelehnt" };
    }
    if (aktion !== "freigeben") throw fail(400, "aktion: freigeben oder ablehnen");
    const fr = rowOut(f);
    let result = "gesehen";
    let odoo;
    if (f.art === "av") result = applyAv(fr);
    else if (f.art === "plan") {
      const moved = applyPlan(fr);
      odoo = [];
      if (helpers.odooMachineMoves) for (const [mid, rows] of moved) odoo.push(...(await helpers.odooMachineMoves(rows, mid)));
      result = `Plan übernommen${moved.size ? `, ${[...moved.values()].reduce((a, r) => a + r.length, 0)} Positionen auf eine Maschine gelegt` : ""}`;
    }
    setStatus.run("freigegeben", now(), who, [result, notiz].filter(Boolean).join(" · "), f.id);
    return { ok: true, status: "freigegeben", ergebnis: result, ...(odoo ? { odoo } : {}) };
  }

  app.post("/api/freigaben/:id", async (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Bitte zuerst unter „Mein Arbeitsplatz“ mit PIN anmelden." });
    try {
      res.json(await decide(req.params.id, req.body && req.body.aktion, req.body && req.body.notiz, staffName(s.e) || `Mitarbeiter ${s.e}`));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // AV-Paket: Zeichnung (neu) lesen und das Paket damit neu aufbauen
  app.post("/api/freigaben/:id/zeichnung", async (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Bitte zuerst unter „Mein Arbeitsplatz“ mit PIN anmelden." });
    const f = db.prepare("SELECT * FROM freigaben WHERE id = ? AND art = 'av' AND status = 'offen'").get(Number(req.params.id));
    if (!f) return res.status(404).json({ error: "Kein offenes AV-Paket" });
    const zs = app.locals.zeichnung;
    if (!zs || !zs.enabled) return res.status(400).json({ error: "Zeichnung lesen ist nicht eingerichtet (TALOS_KEY_DASHBOARD)." });
    const p = JSON.parse(f.daten);
    const inp = inputs();
    const o = inp.orders.find((x) => x.id === p.orderId);
    if (!o) return res.status(404).json({ error: "Position nicht mehr offen" });
    try {
      await zs.lesen(o.odoo_ref || o.parent_ref, { neu: true });
      const next = await buildPaket(o, { n: 1 }, inp.checks, { n: 0 });
      next.kategorie = kategorieOf(next);
      db.prepare("UPDATE freigaben SET daten = ?, geaendert = ? WHERE id = ?").run(JSON.stringify(next), now(), f.id);
      res.json({ ok: true, paket: next });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // AV-Paket: Teil in der Kalkulation berechnen lassen (legt es dort an, falls neu) und die Stunden ins Paket übernehmen
  app.post("/api/freigaben/:id/kalkulation", async (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: "Bitte zuerst unter „Mein Arbeitsplatz“ mit PIN anmelden." });
    const f = db.prepare("SELECT * FROM freigaben WHERE id = ? AND art = 'av' AND status = 'offen'").get(Number(req.params.id));
    if (!f) return res.status(404).json({ error: "Kein offenes AV-Paket" });
    const p = JSON.parse(f.daten);
    const code = codeOf(p.product);
    if (!p.kalkProductId && !code) return res.status(400).json({ error: "Zu diesem Teil gibt es keine Zeichnungsnummer, die Kalkulation findet es nicht." });
    try {
      const k = await kalk.calculate(p.kalkProductId, Number(p.quantity) || 1, code);
      const next = {
        ...p,
        kalkBekannt: true,
        kalkMoeglich: false,
        kalkFehler: null,
        kalkLink: k.link,
        werkstoff: k.material || p.werkstoff,
        rohteil: k.rawPart || p.rohteil,
        programmingMin: k.programmingMin || p.programmingMin,
        hours: p.hours || k.hours,
        hoursSrc: p.hours ? p.hoursSrc : k.hours ? `aus der Kalkulation (${k.basis || "Schätzung"}): Rüsten ${h1(k.setupMin / 60)} h, Fräsen ${h1(k.perPieceMin)} min je Stück` : p.hoursSrc,
        hinweise: (p.hinweise || []).filter((x) => !/kalkuliert|Keine Zeiten/.test(x)),
        notes: { ...(k.material || k.rawPart ? { material: materialNote(k) } : {}), ...(p.notes || {}) },
        machine: p.machine || (machineFromText(k.machine) ? { id: machineFromText(k.machine), why: "laut Kalkulation" } : null),
        warnungen: plausibility({ werkstoff: k.material || "", oberflaechen: p.oberflaechen || [] }),
      };
      db.prepare("UPDATE freigaben SET daten = ?, text = ?, geaendert = ? WHERE id = ?").run(JSON.stringify(next), [next.hours ? `${h1(next.hours)} h` : null, next.werkstoff].filter(Boolean).join(" · "), now(), f.id);
      res.json({ ok: true, paket: next });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Für Talos (MCP) und "Heute zu tun"
  app.locals.freigaben = {
    offen: () => db.prepare("SELECT * FROM freigaben WHERE status = 'offen' ORDER BY erstellt DESC").all().map(rowOut),
    // Talos darf nur Hinweise vorschlagen (Text); ändern tut erst ein Mensch
    hinweis: ({ titel, text, bezug }) =>
      upsert({ art: "hinweis", schluessel: "hinweis:" + Date.now() + ":" + Math.random().toString(36).slice(2, 7), bezug: bezug || null, titel: String(titel).slice(0, 140), text: String(text || "").slice(0, 2000), quelle: "Talos" }),
    vorschau: () => planPreview(inputs()),
    entscheiden: (id, aktion, notiz, who) => decide(id, aktion, notiz, who),
    vorbereiten: async () => ({ av: await prepareAv(), plan: preparePlan({ force: true, talos: false }) }),
  };

  // ---------- Hintergrund ----------
  let busy = false;
  const runAv = async () => {
    if (busy) return;
    busy = true;
    try {
      await prepareAv();
    } catch (err) {
      console.error("AV-Pakete:", err.message);
    } finally {
      busy = false;
    }
  };
  // Morgenvorschlag an Werktagen ab 6 Uhr (deutsche Zeit), einmal je Tag
  const morning = () => {
    try {
      const parts = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(new Date());
      const hour = Number(parts.find((p) => p.type === "hour").value);
      const wd = parts.find((p) => p.type === "weekday").value;
      if (hour < MORNING_HOUR || /^So/.test(wd)) return;
      if (!byKey.get("plan:" + todayStr())) preparePlan();
    } catch (err) {
      console.error("Morgenvorschlag:", err.message);
    }
  };
  if (process.env.FREIGABEN_AUTO !== "0") {
    setTimeout(runAv, 90 * 1000).unref();
    setInterval(runAv, AV_EVERY).unref();
    setTimeout(morning, 120 * 1000).unref();
    setInterval(morning, 5 * 60 * 1000).unref();
  }
  return { prepareAv, preparePlan };
}
