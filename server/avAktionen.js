// AV-Aktionen: was die Arbeitsvorbereitung sonst von Hand in Odoo macht, mit einem Klick aus der App.
//
//   GET  /api/av/aktionen/:orderId            was ansteht: Zeiten (Kalkulation vs. Odoo), Material (fehlt? Vorschlag nach AV001), Fertigungsauftrag (Entwurf?)
//   POST /api/av/aktionen/:orderId/zeiten     Zeiten aus der Kalkulation in die Arbeitsgänge des Fertigungsauftrags und in die Stückliste schreiben,
//                                             Referenz MUSTER entfernen, Stunden der Position setzen
//   POST /api/av/aktionen/:orderId/material   { form }  Rohmaterial nach AV001 suchen oder anlegen (mit Lieferant), in Stückliste und Fertigungsauftrag eintragen
//   POST /api/av/aktionen/:orderId/bestaetigen  Fertigungsauftrag in Odoo bestätigen (Odoo legt dabei die Anfrage für das Material an, AV001 5.7)
//
// Schreiben nur mit Anmeldung (PIN) und nur über den eng freigegebenen Odoo-Zugang der BDE (server/odooClient.js, BDE_WRITE=1).
// Regeln für Material: AV001 Version 2.0 (Odoo-Wissen „AV001 Materialverwaltung und Chargenführung“): Werkstoff Form Maße, keine Varianten,
// Einkauf an, Verkauf aus, Routen „Einkaufen“ und „Auffüllung nach Auftrag“, Chargen über Los, Lieferant nach Werkstoffgruppe.

import { kalkFromEnv, codeOf } from "./kalkClient.js";

const ALU_EN = { "3.2315": "6082", "3.3547": "5083", "3.4365": "7075", "3.1645": "2007", "3.3535": "5754", "3.1325": "2017", "3.3206": "6060", "3.4335": "7020", "3.3555": "5019", "3.3211": "6061", "3.3315": "5005", "3.4325": "7019" };
const EN_ALU = Object.fromEntries(Object.entries(ALU_EN).map(([a, b]) => [b, a]));
const KUNSTSTOFF = /\b(POM|PA ?6|PA ?66|PEEK|PE-?UHMW|PE-?HD|PP\b|PTFE|PVC|PMMA|PET|PVDF|PPS|PC\b)/i;
const LIEFERANT = { edelstahl: "SRS-Stahl", stahl: "EHG Stahl", alu: "BIKAR", kunststoff: "Vink König", sonstiges: "SRS-Stahl" };
const num = (v) => String(Math.round(Number(v) * 10) / 10).replace(".", ",");

// Werkstoff nach AV001 5.3: 1.4301 · 3.2315/6082 · 3.7165/Grade5 · Handelsname bei Kunststoff
export function werkstoffAV001(text) {
  const s = String(text || "").trim();
  let m = /\b3\.7\d{3}\b/.exec(s);
  if (m) return { name: m[0] === "3.7165" ? "3.7165/Grade5" : m[0], gruppe: "sonstiges" };
  m = /\b3\.\d{4}\b/.exec(s);
  if (m) return { name: ALU_EN[m[0]] ? `${m[0]}/${ALU_EN[m[0]]}` : m[0], gruppe: "alu" };
  m = /\bAW[- ]?(\d{4})\b/i.exec(s);
  if (m) return { name: EN_ALU[m[1]] ? `${EN_ALU[m[1]]}/${m[1]}` : `EN AW-${m[1]}`, gruppe: "alu" };
  m = /\b1\.\d{4}\b/.exec(s);
  if (m) return { name: m[0], gruppe: m[0].startsWith("1.4") ? "edelstahl" : "stahl" };
  m = /\b2\.\d{4}\b/.exec(s);
  if (m) return { name: m[0], gruppe: "sonstiges" };
  if (KUNSTSTOFF.test(s)) return { name: s.replace(/[()]/g, "").replace(/\s+/g, " "), gruppe: "kunststoff" };
  return s ? { name: s, gruppe: "sonstiges" } : null;
}

// Rohteil aus der Kalkulation ("30x30x37", "Ø20x40", Dezimalkomma) -> Formen nach AV001 5.1/5.2, mit Vorschlag
export function materialOptionen(werkstoff, rawPart) {
  const w = werkstoffAV001(werkstoff);
  const r = String(rawPart || "").replace(/\s/g, "").replace(/,/g, ".");
  if (!w || !r) return null;
  const opts = [];
  const rd = /^Ø(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(r);
  if (rd) {
    opts.push({ form: "RD", name: `${w.name} RD ${num(rd[1])}`, art: "stange", menge: Number(rd[2]), einheit: "mm" });
    return { werkstoff: w, optionen: opts, vorschlag: "RD" };
  }
  const d = r.split("x").map(Number);
  if (d.length !== 3 || d.some((x) => !(x > 0))) return null;
  const [a, b, c] = d.slice().sort((x, y) => x - y);
  if (Math.abs(a - b) < 0.05) opts.push({ form: "VK", name: `${w.name} VK ${num(a)}`, art: "stange", menge: c, einheit: "mm" });
  else opts.push({ form: "FL", name: `${w.name} FL ${num(b)}x${num(a)}`, art: "stange", menge: c, einheit: "mm" });
  opts.push({ form: "PL", name: `${w.name} PL ${num(a)}x${num(b)}x${num(c)}`, art: "zuschnitt", menge: 1, einheit: "Stk" });
  opts.push({ form: "BLK", name: `${w.name} BLK ${num(a)}x${num(b)}x${num(c)}`, art: "zuschnitt", menge: 1, einheit: "Stk" });
  // Im Zweifel Stangenware; Blech (bis 6 mm) und sehr breite Teile als Zuschnitt aus Platte
  const vorschlag = a <= 6 || b > 200 ? "PL" : opts[0].form;
  return { werkstoff: w, optionen: opts, vorschlag };
}

const STEP = (name) => (/program/i.test(name) ? "prog" : /rüst|ruest/i.test(name) ? "setup" : /fräs|fraes/i.test(name) ? "mach" : null);

export default function registerAvAktionen(app, db, { kalk = kalkFromEnv() } = {}) {
  const odoo = () => app.locals.odooBde;
  const sessionOf = (req) => (app.locals.bdeSession ? app.locals.bdeSession(req) : null);
  const m2oId = (v) => (Array.isArray(v) ? v[0] : v || null);
  const rd = (model, params) => odoo().read(model, "search_read", params);
  const orderOf = (id) => db.prepare("SELECT * FROM orders WHERE id = ? AND done = 0").get(Number(id));

  async function lage(o) {
    const pid = o.odoo_id;
    if (!pid) throw Object.assign(new Error("Die Position hat keinen Fertigungsauftrag in Odoo"), { code: 400 });
    const [prod] = await rd("mrp.production", { domain: [["id", "=", pid]], fields: ["name", "state", "product_id", "product_qty", "bom_id", "move_raw_ids", "location_src_id", "production_location_id", "picking_type_id", "company_id"], limit: 1 });
    if (!prod) throw Object.assign(new Error("Fertigungsauftrag in Odoo nicht gefunden"), { code: 404 });
    const qty = Number(prod.product_qty) || Number(o.quantity) || 1;
    const wos = await rd("mrp.workorder", { domain: [["production_id", "=", pid], ["state", "not in", ["done", "cancel"]]], fields: ["name", "state", "duration_expected", "workcenter_id"], limit: 40 });
    const bomId = m2oId(prod.bom_id);
    const [bom] = bomId ? await rd("mrp.bom", { domain: [["id", "=", bomId]], fields: ["code", "product_tmpl_id", "bom_line_ids", "operation_ids"], limit: 1 }) : [];
    const ops = bomId ? await rd("mrp.routing.workcenter", { domain: [["bom_id", "=", bomId]], fields: ["name", "time_cycle_manual"], limit: 40 }) : [];
    const moves = await rd("stock.move", { domain: [["raw_material_production_id", "=", pid], ["state", "!=", "cancel"]], fields: ["product_id", "product_uom_qty"], limit: 40 });
    const lines = bomId ? await rd("mrp.bom.line", { domain: [["bom_id", "=", bomId]], fields: ["product_id", "product_qty"], limit: 40 }) : [];
    const [pp] = await rd("product.product", { domain: [["id", "=", m2oId(prod.product_id)]], fields: ["product_tmpl_id", "default_code"], limit: 1 });
    const code = (pp && pp.default_code) || codeOf(o.product);
    let k = null;
    if (kalk.enabled && code) {
      try {
        k = await kalk.lookup(code, qty);
      } catch (err) {
        k = { known: false, error: err.message };
      }
    }
    return { prod, qty, wos, bom, ops, moves, lines, pp, code, k };
  }

  function zeitenPlan(L) {
    const { k, qty, wos, ops, bom, pp } = L;
    if (!k || !k.known) return { moeglich: false, grund: k && k.error ? "Kalkulation nicht erreichbar: " + k.error : "Teil ist noch nicht kalkuliert (im AV-Paket „In der Kalkulation berechnen“)" };
    const soll = { prog: k.programmingMin || 0, setup: k.setupMin || 0, machStk: k.perPieceMin || 0 };
    if (!(soll.machStk > 0)) return { moeglich: false, grund: "Die Kalkulation hat keine Fräszeit" };
    const byStep = (list) => list.reduce((m, w) => ((m[STEP(w.name)] = m[STEP(w.name)] || []).push(w), m), {});
    const w = byStep(wos);
    if ((w.mach || []).length > 1 || (w.setup || []).length > 1) return { moeglich: false, grund: "Der Auftrag hat mehrere Rüst- oder Fräs-Arbeitsgänge (aufgeteilt). Zeiten bitte in Odoo von Hand setzen" };
    if (!(w.mach || []).length) return { moeglich: false, grund: "Der Auftrag hat in Odoo keinen Fräs-Arbeitsgang" };
    const o = byStep(ops);
    // Stückliste nur anfassen, wenn sie zu genau diesem Teil gehört (keine gemeinsame Vorlage)
    const eigeneStl = !!bom && !!pp && m2oId(bom.product_tmpl_id) === m2oId(pp.product_tmpl_id) && (o.mach || []).length === 1 && (o.setup || []).length <= 1;
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      moeglich: true,
      quelle: `${k.basis || "Kalkulation"}${k.confidence ? ", Sicherheit " + k.confidence : ""}`,
      link: k.link || null,
      kalk: { programmieren: soll.prog, ruesten: soll.setup, fraesenJeStk: soll.machStk },
      odoo: { programmieren: (w.prog || [])[0]?.duration_expected ?? null, ruesten: (w.setup || [])[0]?.duration_expected ?? null, fraesen: (w.mach || [])[0]?.duration_expected ?? null },
      neu: { programmieren: soll.prog, ruesten: soll.setup, fraesen: r1(soll.machStk * qty) },
      stunden: Math.round(((soll.setup + soll.machStk * qty) / 60) * 10) / 10,
      stueckliste: eigeneStl,
      muster: !!bom && bom.code === "MUSTER",
      ids: { prog: (w.prog || [])[0]?.id || null, setup: (w.setup || [])[0]?.id || null, mach: w.mach[0].id, opProg: eigeneStl ? (o.prog || [])[0]?.id || null : null, opSetup: eigeneStl ? (o.setup || [])[0]?.id || null : null, opMach: eigeneStl ? o.mach[0].id : null },
    };
  }

  async function materialPlan(L, o) {
    const hat = L.moves.length > 0 || L.lines.length > 0;
    const komponenten = [...new Set([...L.moves, ...L.lines].map((m) => (Array.isArray(m.product_id) ? m.product_id[1] : "")).filter(Boolean))];
    if (hat) return { fehlt: false, komponenten };
    const k = L.k;
    const opt = k && k.known ? materialOptionen(k.material, k.rawPart) : null;
    if (!opt) return { fehlt: true, komponenten, moeglich: false, grund: k && k.known ? "Werkstoff oder Rohteil fehlt in der Kalkulation" : "Teil ist noch nicht kalkuliert" };
    // vorhandene Artikel mit genau diesem Namen (AV001: vorher suchen, keinen zweiten anlegen)
    const names = opt.optionen.map((x) => x.name);
    const da = await rd("product.template", { domain: [["name", "in", names]], fields: ["name"], limit: 10 });
    const lieferant = LIEFERANT[opt.werkstoff.gruppe] || "SRS-Stahl";
    return {
      fehlt: true,
      komponenten,
      moeglich: true,
      werkstoff: opt.werkstoff.name,
      gruppe: opt.werkstoff.gruppe,
      rohteil: k.rawPart,
      lieferant,
      vorschlag: opt.vorschlag,
      optionen: opt.optionen.map((x) => ({ ...x, vorhanden: (da.find((d) => d.name === x.name) || {}).id || null, mengeFa: x.art === "stange" ? x.menge * L.qty : L.qty })),
      fa: o.odoo_ref,
    };
  }

  const fail = (res, err) => res.status(err.code || (err.forbidden ? 403 : err.busy ? 429 : 502)).json({ error: err.message });
  const guard = (req, res) => {
    if (!sessionOf(req)) {
      res.status(401).json({ error: "Bitte zuerst unter „Mein Arbeitsplatz“ mit PIN anmelden." });
      return false;
    }
    if (!odoo() || !odoo().writeEnabled) {
      res.status(403).json({ error: "Schreiben in Odoo ist nicht freigeschaltet (BDE_WRITE)." });
      return false;
    }
    return true;
  };

  app.get("/api/av/aktionen/:orderId", async (req, res) => {
    const o = orderOf(req.params.orderId);
    if (!o) return res.status(404).json({ error: "Position nicht offen" });
    if (!odoo() || !odoo().enabled) return res.json({ verfuegbar: false, grund: "Odoo ist nicht angebunden" });
    try {
      const L = await lage(o);
      res.json({
        verfuegbar: true,
        schreiben: !!odoo().writeEnabled,
        fa: { name: L.prod.name, state: L.prod.state, entwurf: L.prod.state === "draft" },
        zeiten: zeitenPlan(L),
        material: await materialPlan(L, o),
        portal: process.env.MATERIALPORTAL_URL || "https://portal.kratos-precision.de",
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/av/aktionen/:orderId/zeiten", async (req, res) => {
    if (!guard(req, res)) return;
    const o = orderOf(req.params.orderId);
    if (!o) return res.status(404).json({ error: "Position nicht offen" });
    try {
      const L = await lage(o);
      const z = zeitenPlan(L);
      if (!z.moeglich) return res.status(400).json({ error: z.grund });
      const done = [];
      const w = (ids, vals) => (ids.filter(Boolean).length ? odoo().write("mrp.workorder", "write", { ids: ids.filter(Boolean), vals }) : null);
      if (z.ids.prog && z.neu.programmieren > 0) await w([z.ids.prog], { duration_expected: z.neu.programmieren });
      if (z.ids.setup) await w([z.ids.setup], { duration_expected: z.neu.ruesten });
      await w([z.ids.mach], { duration_expected: z.neu.fraesen });
      done.push(`Arbeitsgänge ${L.prod.name}: ${z.neu.programmieren ? `Programmieren ${z.neu.programmieren} min, ` : ""}Rüsten ${z.neu.ruesten} min, Fräsen ${String(z.neu.fraesen).replace(".", ",")} min`);
      if (z.stueckliste) {
        const r = (id, v) => (id ? odoo().write("mrp.routing.workcenter", "write", { ids: [id], vals: { time_cycle_manual: v } }) : null);
        if (z.neu.programmieren > 0) await r(z.ids.opProg, z.neu.programmieren);
        await r(z.ids.opSetup, z.neu.ruesten);
        await r(z.ids.opMach, z.kalk.fraesenJeStk);
        done.push("Stückliste: Zeiten je Stück eingetragen");
        if (z.muster) {
          await odoo().write("mrp.bom", "write", { ids: [L.bom.id], vals: { code: false } });
          done.push("Referenz MUSTER entfernt");
        }
      } else done.push("Stückliste nicht geändert (gehört nicht nur zu diesem Teil oder ist aufgeteilt)");
      db.prepare("UPDATE orders SET hours = ?, hours_plan = ?, odoo_bom = CASE WHEN odoo_bom = 'muster' THEN 'ok' ELSE odoo_bom END WHERE id = ?").run(z.stunden, z.stunden, o.id);
      done.push(`Planung: ${String(z.stunden).replace(".", ",")} h`);
      res.json({ ok: true, erledigt: done, stunden: z.stunden });
    } catch (err) {
      fail(res, err);
    }
  });

  async function findId(model, domain, order = "id desc") {
    const [r] = await rd(model, { domain, fields: ["id"], order, limit: 1 });
    return r ? r.id : null;
  }

  app.post("/api/av/aktionen/:orderId/material", async (req, res) => {
    if (!guard(req, res)) return;
    const o = orderOf(req.params.orderId);
    if (!o) return res.status(404).json({ error: "Position nicht offen" });
    try {
      const L = await lage(o);
      const m = await materialPlan(L, o);
      if (!m.fehlt) return res.status(400).json({ error: "Der Fertigungsauftrag hat schon Material: " + m.komponenten.join(", ") });
      if (!m.moeglich) return res.status(400).json({ error: m.grund });
      const form = String((req.body && req.body.form) || m.vorschlag);
      const x = m.optionen.find((y) => y.form === form);
      if (!x) return res.status(400).json({ error: "Unbekannte Form " + form });
      if (!["draft", "confirmed"].includes(L.prod.state)) return res.status(400).json({ error: `Der Fertigungsauftrag ist schon ${L.prod.state === "progress" ? "in Arbeit" : "abgeschlossen"}. Material bitte in Odoo eintragen` });
      if (!L.bom) return res.status(400).json({ error: "Der Fertigungsauftrag hat keine Stückliste" });
      const done = [];
      let tmplId = x.vorhanden;
      if (!tmplId) {
        const stange = x.art === "stange";
        const categ = await findId("product.category", [["complete_name", "=", stange ? "All / Rohmaterial / Stangenware" : "All / Rohmaterial / Zuschnitt"]]);
        const uom = await findId("uom.uom", [["name", "=", stange ? "mm" : "Einheit(en)"]], "id asc");
        const einkaufen = await findId("stock.route", [["name", "=", "Einkaufen"]], "id asc");
        const mto = await findId("stock.route", [["name", "=ilike", "Auffüllung nach Auftrag%"]], "id asc");
        const partner = await findId("res.partner", [["name", "ilike", m.lieferant], ["is_company", "=", true]], "id asc");
        const fehlt = [!categ && "Kategorie", !uom && "Maßeinheit", !einkaufen && "Route Einkaufen", !mto && "Route Auffüllung nach Auftrag", !partner && "Lieferant " + m.lieferant].filter(Boolean);
        if (fehlt.length) return res.status(400).json({ error: "In Odoo fehlt: " + fehlt.join(", ") + ". Es wurde nichts angelegt." });
        const [id] = await odoo().write("product.template", "create", {
          vals_list: [{ name: x.name, type: "consu", is_storable: true, categ_id: categ, uom_id: uom, purchase_ok: true, sale_ok: false, route_ids: [[6, 0, [einkaufen, mto]]], tracking: "lot", seller_ids: [[0, 0, { partner_id: partner }]] }],
        });
        tmplId = id;
        done.push(`Artikel angelegt: ${x.name} (${stange ? "Stangenware, mm" : "Zuschnitt, Einheiten"}, Lieferant ${m.lieferant})`);
      } else done.push(`Artikel vorhanden: ${x.name}`);
      const [variant] = await rd("product.product", { domain: [["product_tmpl_id", "=", tmplId]], fields: ["id", "uom_id"], limit: 1 });
      if (!variant) return res.status(502).json({ error: "Der Artikel hat in Odoo keine Variante" });
      const uomId = m2oId(variant.uom_id);
      await odoo().write("mrp.bom.line", "create", { vals_list: [{ bom_id: L.bom.id, product_id: variant.id, product_qty: x.menge, product_uom_id: uomId }] });
      done.push(`Stückliste: ${x.name}, ${String(x.menge).replace(".", ",")} ${x.einheit === "mm" ? "mm" : "Stk"} je Teil`);
      await odoo().write("mrp.production", "write", {
        ids: [L.prod.id],
        vals: { move_raw_ids: [[0, 0, { product_id: variant.id, product_uom_qty: x.mengeFa, product_uom: uomId, location_id: m2oId(L.prod.location_src_id), location_dest_id: m2oId(L.prod.production_location_id), picking_type_id: m2oId(L.prod.picking_type_id), company_id: m2oId(L.prod.company_id) }]] },
      });
      done.push(`${L.prod.name}: Material ${String(x.mengeFa).replace(".", ",")} ${x.einheit === "mm" ? "mm" : "Stk"} eingetragen`);
      res.json({ ok: true, erledigt: done, artikel: x.name });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/av/aktionen/:orderId/bestaetigen", async (req, res) => {
    if (!guard(req, res)) return;
    const o = orderOf(req.params.orderId);
    if (!o) return res.status(404).json({ error: "Position nicht offen" });
    try {
      const L = await lage(o);
      if (L.prod.state !== "draft") return res.status(400).json({ error: `${L.prod.name} ist schon bestätigt` });
      await odoo().write("mrp.production", "action_confirm", { ids: [L.prod.id] });
      try {
        db.prepare("UPDATE orders SET odoo_draft = 0 WHERE id = ?").run(o.id);
      } catch {
        /* Spalte gibt es nicht in jeder Datenbank */
      }
      res.json({ ok: true, erledigt: [`${L.prod.name} in Odoo bestätigt${L.moves.length || L.lines.length ? "; Odoo legt die Anfrage für das Material an" : ""}`] });
    } catch (err) {
      fail(res, err);
    }
  });
}
