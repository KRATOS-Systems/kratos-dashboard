// Meine nächsten Teile: was der angemeldete Mitarbeiter als Nächstes tun soll, aus der Planung (Reihenfolge, Maschine, Zuständigkeit),
// der Arbeitsvorbereitung (ist alles bereit?) und Odoo (welche Arbeitsgänge sind noch offen, nur lesen).
//
// - Teile: Positionen, bei denen er für Programmierung, Rüsten oder Fräsen zuständig ist (eingeplant auf einer Maschine, Reihenfolge
//   des Zeitstrahls) und, wenn er für die QS zuständig ist, die Positionen in der QS. Ohne Maschine nur bei ausdrücklicher Zuweisung.
// - Arbeitsvorbereitung: offene AV-Punkte, für die er zuständig ist (Zuständiger am Punkt, sonst die Rolle Arbeitsvorbereitung),
//   auch für noch nicht eingeplante Positionen.
// - Planung: wer die Rolle Produktionsplanung hat, sieht die Zahl der noch nicht eingeplanten Positionen.
// - Zur Info: Arbeit anderer, die in den Einstellungen der Planung jemandem zur Information zugeordnet ist
//   (z. B. "Arbeitsvorbereitung von Nino zur Info an Frank" während der Einarbeitung); nur ansehen, keine Knöpfe.

import { ACTIVITIES, responsible, avResponsible, staffName } from "../src/staffLib.js";
import { avKey, avSummary } from "../src/avLib.js";
import { labelOf, m2o } from "./bde.js";

const MACHINES = [
  { id: "dmu40", name: "DMU 40 eVo" },
  { id: "dmu50", name: "DMU 50" },
  { id: "m1", name: "M1" },
  { id: "h800u", name: "POS H800U" },
];
const MACHINE_IDS = MACHINES.map((m) => m.id);
const LIMIT = 6;
const AV_LIMIT = 8;
const ODOO_TTL = 60 * 1000;
const ACT_BY_LABEL = { Programmierung: "programmierung", Rüsten: "ruesten", Fräsen: "fraesen", QS: "qs" };

export default function registerBdeParts(app, db, ctx, staff) {
  const woCache = new Map(); // Produktions-ID -> { at, wos }

  // Offene Arbeitsgänge der Fertigungsaufträge aus Odoo (nur lesen), je Auftrag eine Minute zwischengespeichert
  async function workorders(productionIds) {
    const need = productionIds.filter((id) => {
      const c = woCache.get(id);
      return !c || Date.now() - c.at > ODOO_TTL;
    });
    if (need.length) {
      const rows = await ctx.odoo.read("mrp.workorder", "search_read", {
        domain: [["production_id", "in", need]],
        fields: ["production_id", "workcenter_id", "state"],
        limit: 500,
      });
      need.forEach((id) => woCache.set(id, { at: Date.now(), wos: [] }));
      rows.forEach((w) => {
        const pid = m2o(w.production_id)?.id;
        const act = ACT_BY_LABEL[labelOf(m2o(w.workcenter_id)?.name)];
        if (pid && act) woCache.get(pid).wos.push({ id: w.id, act, state: w.state });
      });
    }
    return new Map(productionIds.map((id) => [id, (woCache.get(id) || { wos: [] }).wos]));
  }

  function load() {
    const orders = db
      .prepare(
        `SELECT id, machine, from_machine, position, order_no, odoo_id, source, product, quantity, due_date, extern_start, part_label
         FROM orders WHERE done = 0`
      )
      .all();
    const checks = new Map(db.prepare("SELECT order_id, item, status, due, note, assignee FROM av_checks").all().map((c) => [avKey(c.order_id, c.item), c]));
    return { orders, checks, defaults: staff.defaults(), overrides: staff.overrides() };
  }

  const posNo = (o) => (o.part_label ? `${o.order_no} · ${o.part_label}` : o.order_no);
  const base = (o) => ({
    orderId: o.id,
    fa: posNo(o),
    source: o.source || null,
    odooId: o.odoo_id || null,
    product: o.product || null,
    quantity: o.quantity ?? null,
    due: o.due_date || null,
    machine: MACHINES.find((m) => m.id === o.machine)?.name || (o.machine === "qs" ? "QS" : null),
  });

  // Offene AV-Punkte einer Position, für die "name" zuständig ist
  function avFor(o, data, name) {
    const sum = avSummary(data.checks, o.id);
    const mine = sum.open.filter((s) => avResponsible(o, s.id, s.assignee, data.defaults, data.overrides) === name);
    return { sum, mine };
  }

  // Reihenfolge wie im Zeitstrahl: Maschine, dann Position; ohne Maschine nach Liefertermin
  const queueOrder = (a, b) =>
    (MACHINE_IDS.includes(a.machine) ? 0 : 1) - (MACHINE_IDS.includes(b.machine) ? 0 : 1) ||
    String(a.machine).localeCompare(String(b.machine)) ||
    (a.position ?? 0) - (b.position ?? 0) ||
    String(a.due_date || "9999").localeCompare(String(b.due_date || "9999"));

  function avList(data, name) {
    return data.orders
      .filter((o) => o.machine !== "extern" && o.machine !== "extern_fert" && o.machine !== "qs")
      .sort(queueOrder)
      .map((o) => ({ o, ...avFor(o, data, name) }))
      .filter((x) => x.mine.length)
      .map(({ o, mine, sum }) => ({ ...base(o), open: mine.map((s) => s.label), readyBy: sum.readyDate || null, planned: MACHINE_IDS.includes(o.machine) }));
  }

  // Teile mit Tätigkeiten von "name": eingeplant auf einer Maschine (Reihenfolge des Zeitstrahls) oder in der QS;
  // erledigte Arbeitsgänge (Odoo) fallen weg
  async function itemsFor(data, name) {
    const ownSet = (o, act) => data.overrides.has(`${o.id}|${act}`);
    const raw = data.orders
      .map((o) => {
        const onMachine = MACHINE_IDS.includes(o.machine);
        const acts = ACTIVITIES.filter((a) => {
          if (responsible(o, a.id, data.defaults, data.overrides) !== name) return false;
          if (a.id === "qs") return o.machine === "qs";
          return onMachine || (!o.machine && ownSet(o, a.id));
        }).map((a) => a.id);
        return acts.length ? { o, acts, onMachine } : null;
      })
      .filter(Boolean)
      .sort((x, y) => (x.o.machine === "qs" ? 0 : 1) - (y.o.machine === "qs" ? 0 : 1) || String(x.o.extern_start || "").localeCompare(String(y.o.extern_start || "")) || queueOrder(x.o, y.o));
    const ids = [...new Set(raw.slice(0, LIMIT * 3).map((x) => x.o.odoo_id).filter(Boolean))];
    let wos = new Map();
    try {
      wos = ids.length ? await workorders(ids) : new Map();
    } catch (err) {
      if (!err.busy && !err.offline) throw err; // Odoo gerade nicht erreichbar: ohne Arbeitsgang-Status weiter
    }
    return raw
      .map(({ o, acts, onMachine }) => {
        const list = wos.get(o.odoo_id) || [];
        const steps = acts
          .map((act) => {
            const w = list.find((x) => x.act === act);
            return { id: act, label: ACTIVITIES.find((a) => a.id === act).label, workorderId: w ? w.id : null, state: w ? w.state : null };
          })
          .filter((st) => st.state !== "done" && st.state !== "cancel");
        const { sum } = avFor(o, data, name);
        return steps.length ? { ...base(o), noMachine: !onMachine && o.machine !== "qs", steps, avReady: sum.ready, avOpen: sum.open.map((x) => x.label) } : null;
      })
      .filter(Boolean);
  }

  app.get("/api/bde/teile", async (req, res) => {
    const s = ctx.readSession(req);
    if (!s) return res.status(401).json({ error: "Bitte anmelden" });
    const target = req.query.id != null ? Number(req.query.id) : s.e;
    if (target !== s.e && !(s.leitung && ctx.PEOPLE.includes(target))) return res.status(403).json({ error: "Nur die eigenen Teile" });
    const name = staffName(target);
    if (!name) return res.json({ name: null, items: [], av: [], avTotal: 0, planning: null, info: [] });
    try {
      const data = load();
      const items = await itemsFor(data, name);
      const av = avList(data, name);
      const planning =
        data.defaults["role:planung"] === name
          ? (() => {
              const unplanned = data.orders.filter((o) => !o.machine);
              return { unplanned: unplanned.length, ready: unplanned.filter((o) => avSummary(data.checks, o.id).ready).length };
            })()
          : null;
      // Zur Info: Arbeit anderer, die dieser Person zur Information gezeigt wird (z. B. Arbeitsvorbereitung von Nino an Frank)
      const info = [];
      for (const rule of staff.info().filter((x) => x.target === name)) {
        const list = rule.scope === "av" ? avList(data, rule.source) : await itemsFor(data, rule.source);
        info.push({ source: rule.source, scope: rule.scope, total: list.length, items: list.slice(0, 12) });
      }

      res.json({ name, items: items.slice(0, LIMIT), more: Math.max(0, items.length - LIMIT), av: av.slice(0, AV_LIMIT), avTotal: av.length, planning, info, odooUrl: ctx.odoo.url || null });
    } catch (err) {
      ctx.fail(res, err);
    }
  });
}

