// Planung für Talos (und jede andere KI) als MCP-Server: nur lesen und durchrechnen, nie speichern.
// Rechnet mit derselben Planungslogik wie das Planungsfenster (src/planLogic.js), damit Talos genau die Zahlen nennt,
// die man im Zeitstrahl sieht.
//
// Erreichbar unter POST /mcp/<TALOS_PLAN_SECRET> (Streamable HTTP, zustandslos, JSON-Antworten), vor dem Passwortschutz der App.
// Ohne TALOS_PLAN_SECRET (mind. 24 Zeichen) ist der Endpunkt aus.
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { MACHINES, addDays, mondayOf, daysBetween, todayStr, DEFAULT_WEEK_CAPACITY } from "../src/lib.js";
import { buildPlanDeps, buildGroups, applyMove, byPosition, groupKeyOf, groupLabelOf } from "../src/planLogic.js";
import { avKey, avSummary } from "../src/avLib.js";

const MAX_TEXT = 60000;
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Alle Eingaben der Planung aus der Datenbank, wie sie das Planungsfenster lädt
export function loadPlanInputs(db, { orderOut, planSettingsOut }, today = todayStr()) {
  const orders = db.prepare("SELECT * FROM orders ORDER BY machine, position, id").all().map(orderOut);
  const rates = Object.fromEntries(db.prepare("SELECT machine, weekly_hours FROM plan_rates").all().map((r) => [r.machine, r.weekly_hours]));
  const weekCap = Object.fromEntries(db.prepare("SELECT reading_date, capacity_hours FROM week_capacity").all().map((r) => [r.reading_date, r.capacity_hours]));
  const freeDays = db.prepare("SELECT date, name FROM free_days ORDER BY date").all();
  const checks = new Map(db.prepare("SELECT order_id, item, status, due, note, assignee FROM av_checks").all().map((c) => [avKey(c.order_id, c.item), c]));
  const settings = planSettingsOut();
  return { orders, rates, weekCap, freeDays, checks, settings, today };
}

// Wie Planning.jsx: Zeitachse ab Montag dieser Woche, Wochenleistung = Schichtmodell x Nutzung
export function makeContext({ rates, weekCap, freeDays, checks, settings, today }) {
  const monday0 = mondayOf(today);
  const todayOff = daysBetween(monday0, today);
  const free = new Set(freeDays.map((d) => daysBetween(monday0, d.date)));
  const schedule = Object.keys(weekCap)
    .sort()
    .map((d) => ({ off: daysBetween(monday0, d), hours: weekCap[d] }));
  const hoursAt = (day) => {
    let h = DEFAULT_WEEK_CAPACITY;
    for (const e of schedule) {
      if (e.off <= day) h = e.hours;
      else break;
    }
    return h;
  };
  const util = settings.utilization;
  const defaults = { now: (hoursAt(todayOff) * util) / 100, perDayAt: (day) => (hoursAt(day) * util) / 100 / 6 };
  const withAv = (list) =>
    list.map((o) => {
      if (o.done) return o;
      const s = avSummary(checks, o.id);
      return !s.ready && s.readyDate ? { ...o, av_ready: s.readyDate } : o;
    });
  const dateOf = (off) => addDays(monday0, Math.floor(off));
  const endDateOf = (off) => dateOf(off - 1e-6);
  const compute = (orders) => {
    const plan = buildPlanDeps(withAv(orders), rates, defaults, monday0, todayOff, free);
    const groups = buildGroups(orders, plan, monday0, settings.tight_days);
    return { plan, groups };
  };
  return { monday0, todayOff, free, rates, defaults, dateOf, endDateOf, compute, freeDays, today };
}

const WAIT = { av: "Arbeitsvorbereitung (offene Punkte)", dep: "vorheriger Arbeitsgang", earliest: "Start frühestens (Material/Werkzeug)" };

function itemOut(ctx, i, index) {
  const o = i.o;
  return {
    platz: index + 1,
    id: o.id,
    auftrag: groupLabelOf(o),
    fa: o.order_no || undefined,
    teil: o.part_label || undefined,
    produkt: o.product || undefined,
    menge: o.quantity ?? undefined,
    stunden_gesamt: round1(o.hours),
    stunden_rest: round1(i.remaining),
    fortschritt_prozent: i.percent ?? undefined,
    ...(i.scheduled
      ? {
          start: ctx.dateOf(i.pastStart ?? i.start),
          ende: ctx.endDateOf(i.end),
          liefertermin: o.due || undefined,
          ...(i.diff != null ? (i.diff > 0 ? { verspaetung_tage: Math.ceil(i.diff) } : { puffer_tage: Math.floor(-i.diff) }) : {}),
          ...(i.waitReason ? { wartet_auf: WAIT[i.waitReason], wartet_ab: ctx.dateOf(i.waitFrom) } : {}),
        }
      : { nicht_eingeplant: "keine Reststunden oder keine Wochenleistung" }),
  };
}

function groupOut(ctx, g) {
  return {
    auftrag: g.label,
    liefertermin: g.due || undefined,
    voraussichtlich_fertig: g.end != null ? ctx.endDateOf(g.end) : undefined,
    zuletzt_an: g.endMachine || undefined,
    status: g.status === "late" ? "zu spät" : g.status === "tight" ? "knapp" : "ok",
    ...(g.diff != null ? (g.diff > 0 ? { verspaetung_tage: Math.ceil(g.diff) } : { puffer_tage: Math.floor(-g.diff) }) : {}),
    positionen: g.total,
    erledigt: g.finished,
    nicht_eingeplant: g.unscheduled || undefined,
    extern: g.externTags?.length ? g.externTags : undefined,
  };
}

const machineOf = (key) => {
  const k = String(key || "").toLowerCase().replace(/\s+/g, "");
  return MACHINES.find((m) => m.id === k || m.short.toLowerCase().replace(/\s+/g, "") === k || m.name.toLowerCase().replace(/\s+/g, "").includes(k));
};

// Positionen per FA-Nummer, Auftragsnummer (Quelle) oder id finden
function findPositions(orders, ref) {
  const r = String(ref || "").trim().toLowerCase();
  if (!r) return [];
  const open = orders.filter((o) => !o.done);
  const byId = /^\d+$/.test(r) ? open.filter((o) => o.id === Number(r)) : [];
  if (byId.length) return byId;
  return open.filter((o) => (o.order_no || "").toLowerCase() === r || (o.source || "").toLowerCase() === r || (o.odoo_ref || "").toLowerCase() === r);
}

// Vergleich zweier Planungen: wer wird später, wer reißt den Termin
function compare(ctx, before, after, focusKeys = new Set()) {
  const b = new Map(before.groups.map((g) => [g.key, g]));
  const changes = [];
  for (const g of after.groups) {
    const old = b.get(g.key);
    if (!old || old.end == null || g.end == null) continue;
    const shift = Math.round((g.end - old.end) * 10) / 10;
    if (Math.abs(shift) < 0.1 && !focusKeys.has(g.key)) continue;
    changes.push({
      auftrag: g.label,
      vorher_fertig: ctx.endDateOf(old.end),
      nachher_fertig: ctx.endDateOf(g.end),
      verschiebung_tage: shift,
      liefertermin: g.due || undefined,
      vorher: old.status === "late" ? "zu spät" : old.status === "tight" ? "knapp" : "ok",
      nachher: g.status === "late" ? "zu spät" : g.status === "tight" ? "knapp" : "ok",
      ...(focusKeys.has(g.key) ? { verschoben: true } : {}),
    });
  }
  const late = (x) => x.groups.filter((g) => g.status === "late");
  const sum = (x) => late(x).reduce((s, g) => s + g.lateDays, 0);
  return {
    zu_spaet_vorher: late(before).length,
    zu_spaet_nachher: late(after).length,
    verspaetungstage_vorher: sum(before),
    verspaetungstage_nachher: sum(after),
    neu_zu_spaet: changes.filter((c) => c.vorher !== "zu spät" && c.nachher === "zu spät").map((c) => c.auftrag),
    nicht_mehr_zu_spaet: changes.filter((c) => c.vorher === "zu spät" && c.nachher !== "zu spät").map((c) => c.auftrag),
    aenderungen: changes.sort((x, y) => Math.abs(y.verschiebung_tage) - Math.abs(x.verschiebung_tage)).slice(0, 25),
  };
}

// Neuer, noch nicht angelegter Auftrag als Platzhalter für die Simulation
const PLACEHOLDER_ID = -1;
const placeholder = (neu, machine) => ({
  id: PLACEHOLDER_ID,
  machine,
  order_no: neu.bezeichnung || "NEU",
  source: neu.bezeichnung || "NEU (Simulation)",
  hours: neu.stunden,
  done_hours: 0,
  due: neu.liefertermin || null,
  position: 9999,
  done: false,
  extern_tags: [],
  extern_days: 7,
});

export function planTools(getInputs) {
  const machineIds = MACHINES.map((m) => m.short).join(", ");
  return [
    {
      name: "plan_uebersicht",
      description:
        `Aktuelle Maschinenplanung aus dem Produktionsdashboard (Maschinen: ${machineIds}): Reihenfolge je Maschine mit Start, voraussichtlichem Ende, Liefertermin, Puffer bzw. Verspätung und worauf eine Position wartet; dazu alle Aufträge mit Status (ok, knapp, zu spät), freie Tage und Wochenleistung. Daten wie im Planungsfenster.`,
      inputSchema: {
        type: "object",
        properties: {
          maschine: { type: "string", description: `nur diese Maschine (${machineIds})` },
          nur_auftraege: { type: "boolean", description: "nur die Auftragsübersicht ohne Maschinenreihenfolge" },
        },
        additionalProperties: false,
      },
      run: ({ maschine, nur_auftraege } = {}) => {
        const inp = getInputs();
        const ctx = makeContext(inp);
        const { plan, groups } = ctx.compute(inp.orders);
        const only = maschine ? machineOf(maschine) : null;
        if (maschine && !only) throw new Error(`Maschine "${maschine}" unbekannt. Bekannt: ${machineIds}`);
        const unplanned = inp.orders.filter((o) => !o.done && !o.machine);
        return {
          stand: new Date().toISOString(),
          heute: inp.today,
          nutzung_prozent: inp.settings.utilization,
          knapp_ab_tagen_puffer: inp.settings.tight_days,
          freie_tage_naechste_8_wochen: ctx.freeDays.filter((d) => d.date >= inp.today && d.date <= addDays(inp.today, 56)).map((d) => `${d.date} ${d.name}`),
          ...(nur_auftraege
            ? {}
            : {
                maschinen: plan
                  .filter((p) => !only || p.m.id === only.id)
                  .map((p) => ({
                    maschine: p.m.short,
                    wochenleistung_h: round1(p.rate),
                    frei_ab: p.freeAt != null ? ctx.dateOf(p.freeAt) : inp.today,
                    reihenfolge: p.items.map((it, idx) => itemOut(ctx, it, idx)),
                  })),
              }),
          auftraege: groups.map((g) => groupOut(ctx, g)),
          ...(unplanned.length ? { noch_keiner_maschine_zugeordnet: unplanned.map((o) => ({ id: o.id, auftrag: groupLabelOf(o), fa: o.order_no, stunden: o.hours, liefertermin: o.due })) } : {}),
        };
      },
    },
    {
      name: "plan_simulieren",
      description:
        "Rechnet durch, was passiert, wenn eine vorhandene Position (FA-Nummer, Auftragsnummer oder id) oder ein neuer Auftrag (stunden, liefertermin) auf einer Maschine an einen bestimmten Platz geschoben wird. Speichert nichts. Liefert, welche Aufträge sich wie weit verschieben und wer dadurch zu spät wird.",
      inputSchema: {
        type: "object",
        properties: {
          maschine: { type: "string", description: `Zielmaschine (${machineIds})` },
          platz: { type: "integer", minimum: 1, description: "Platz in der Reihenfolge, 1 = als Nächstes" },
          position: { type: "string", description: "vorhandene Position: FA-Nummer, Auftragsnummer (alle offenen Positionen) oder id" },
          neu: {
            type: "object",
            description: "neuer Auftrag, der noch nicht in der Planung steht",
            properties: { stunden: { type: "number", exclusiveMinimum: 0 }, liefertermin: { type: "string", description: "JJJJ-MM-TT" }, bezeichnung: { type: "string" } },
            required: ["stunden"],
            additionalProperties: false,
          },
        },
        required: ["maschine", "platz"],
        additionalProperties: false,
      },
      run: ({ maschine, platz, position, neu }) => {
        const m = machineOf(maschine);
        if (!m) throw new Error(`Maschine "${maschine}" unbekannt. Bekannt: ${machineIds}`);
        if (!position === !neu) throw new Error("Entweder position (vorhanden) oder neu (Stunden, Liefertermin) angeben.");
        const inp = getInputs();
        const ctx = makeContext(inp);
        let orders = inp.orders;
        let ids;
        if (neu) {
          orders = [...orders, placeholder(neu, m.id)];
          ids = [PLACEHOLDER_ID];
        } else {
          ids = findPositions(orders, position).map((o) => o.id);
          if (!ids.length) throw new Error(`Keine offene Position zu "${position}" gefunden.`);
        }
        const before = ctx.compute(neu ? inp.orders : orders);
        const moved = applyMove(orders, ids, m.id, platz - 1).orders;
        const after = ctx.compute(moved);
        const keys = new Set(moved.filter((o) => ids.includes(o.id)).map(groupKeyOf));
        const target = after.plan.find((p) => p.m.id === m.id);
        const mine = target.items.filter((i) => ids.includes(i.o.id));
        return {
          simulation: true,
          hinweis: "Nur durchgerechnet, nichts gespeichert. Umplanen im Planungsfenster per Ziehen.",
          maschine: m.short,
          platz,
          eingeschoben: mine.map((i) => itemOut(ctx, i, target.items.indexOf(i))),
          ...compare(ctx, neu ? { groups: before.groups } : before, after, keys),
        };
      },
    },
    {
      name: "plan_platz_finden",
      description:
        "Sucht für einen neuen Auftrag (stunden, liefertermin) oder eine vorhandene Position den besten Platz: probiert jede Stelle auf jeder (oder einer) Maschine durch und bewertet nach neu verspäteten Aufträgen, Verspätungstagen und Termintreue des eingeschobenen Auftrags. Liefert die besten Varianten zum Vergleich. Speichert nichts.",
      inputSchema: {
        type: "object",
        properties: {
          position: { type: "string", description: "vorhandene Position: FA-Nummer, Auftragsnummer oder id" },
          neu: {
            type: "object",
            properties: { stunden: { type: "number", exclusiveMinimum: 0 }, liefertermin: { type: "string", description: "JJJJ-MM-TT" }, bezeichnung: { type: "string" } },
            required: ["stunden"],
            additionalProperties: false,
          },
          maschine: { type: "string", description: `nur diese Maschine (${machineIds}); leer = alle` },
          varianten: { type: "integer", minimum: 1, maximum: 5, description: "Anzahl der besten Varianten (Standard 3)" },
        },
        additionalProperties: false,
      },
      run: ({ position, neu, maschine, varianten = 3 }) => {
        if (!position === !neu) throw new Error("Entweder position (vorhanden) oder neu (Stunden, Liefertermin) angeben.");
        const inp = getInputs();
        const ctx = makeContext(inp);
        const only = maschine ? machineOf(maschine) : null;
        if (maschine && !only) throw new Error(`Maschine "${maschine}" unbekannt. Bekannt: ${machineIds}`);
        const base = ctx.compute(inp.orders);
        const results = [];
        for (const m of MACHINES.filter((x) => !only || x.id === only.id)) {
          let orders = inp.orders;
          let ids;
          if (neu) {
            orders = [...orders, placeholder(neu, m.id)];
            ids = [PLACEHOLDER_ID];
          } else {
            ids = findPositions(orders, position).map((o) => o.id);
            if (!ids.length) throw new Error(`Keine offene Position zu "${position}" gefunden.`);
          }
          const queue = orders.filter((o) => o.machine === m.id && !o.done && !ids.includes(o.id)).sort(byPosition);
          for (let idx = 0; idx <= queue.length; idx++) {
            const moved = applyMove(orders, ids, m.id, idx).orders;
            const after = ctx.compute(moved);
            const keys = new Set(moved.filter((o) => ids.includes(o.id)).map(groupKeyOf));
            const cmp = compare(ctx, base, after, keys);
            const own = after.groups.find((g) => keys.has(g.key));
            const ownLate = own?.lateDays || 0;
            const othersNewLate = cmp.neu_zu_spaet.filter((a) => !own || a !== own.label).length;
            results.push({
              score: othersNewLate * 1000 + Math.max(0, cmp.verspaetungstage_nachher - cmp.verspaetungstage_vorher) * 10 + ownLate * 20 + idx * 0.01,
              maschine: m.short,
              platz: idx + 1,
              vor: queue[idx] ? groupLabelOf(queue[idx]) + (queue[idx].order_no ? ` (${queue[idx].order_no})` : "") : "am Ende",
              eigener_auftrag: own ? groupOut(ctx, own) : undefined,
              andere_neu_zu_spaet: cmp.neu_zu_spaet.filter((a) => !own || a !== own.label),
              verspaetungstage_gesamt: { vorher: cmp.verspaetungstage_vorher, nachher: cmp.verspaetungstage_nachher },
              am_staerksten_verschoben: cmp.aenderungen.filter((c) => !c.verschoben).slice(0, 3),
            });
          }
        }
        results.sort((a, b) => a.score - b.score);
        return {
          simulation: true,
          hinweis: "Nur durchgerechnet, nichts gespeichert. Bewertung: zuerst keine anderen Aufträge neu verspäten, dann wenig Verspätungstage, dann eigener Termin.",
          gepruefte_varianten: results.length,
          beste: results.slice(0, varianten).map(({ score, ...r }) => r),
        };
      },
    },
  ];
}

// Minimaler MCP-Server (JSON-RPC über HTTP POST, zustandslos)
export default function registerTalosPlan(app, db, helpers) {
  const SECRET = process.env.TALOS_PLAN_SECRET || "";
  if (SECRET.length < 24) {
    console.log("Talos-Planung (MCP) aus: TALOS_PLAN_SECRET fehlt");
    return;
  }
  const tools = planTools(() => loadPlanInputs(db, helpers));
  const same = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const reply = (res, id, result) => res.json({ jsonrpc: "2.0", id, result });
  const error = (res, id, code, message) => res.json({ jsonrpc: "2.0", id, error: { code, message } });

  // Eigener Body-Parser: Die Route wird vor dem Passwortschutz der App angemeldet (Schutz hier über das Geheimnis)
  app.all("/mcp/:secret", express.json({ limit: "1mb" }), (req, res) => {
    if (!same(req.params.secret, SECRET)) return res.status(404).end();
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").end();
    const { id = null, method, params = {} } = req.body || {};
    if (id === null || id === undefined) return res.status(202).end(); // Benachrichtigung (z. B. initialized)
    if (method === "initialize") {
      return reply(res, id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "kratos-planung", version: "1.0.0" },
        instructions:
          "Maschinenplanung der KRATOS Precision (Produktionsdashboard). Nur lesen und durchrechnen, nichts wird gespeichert. Quelle in Antworten: „Planung Produktionsdashboard, Stand <Zeit>“.",
      });
    }
    if (method === "ping") return reply(res, id, {});
    if (method === "tools/list") {
      return reply(res, id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true } })) });
    }
    if (method === "tools/call") {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return error(res, id, -32602, `Werkzeug ${params.name} unbekannt`);
      try {
        let text = JSON.stringify(tool.run(params.arguments || {}));
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "…[gekürzt – Maschine angeben oder nur_auftraege nutzen]";
        return reply(res, id, { content: [{ type: "text", text }] });
      } catch (e) {
        return reply(res, id, { content: [{ type: "text", text: `Fehler: ${e.message}` }], isError: true });
      }
    }
    return error(res, id, -32601, `Methode ${method} nicht unterstützt`);
  });
  console.log("Talos-Planung (MCP) an");
}
