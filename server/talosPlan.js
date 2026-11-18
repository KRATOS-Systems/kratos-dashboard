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
import { avKey, avSummary, AV_STATUS } from "../src/avLib.js";
import { chatTools } from "./chatPlan.js";

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
      const mat = s.states.find((x) => x.id === "material");
      const material_ok = !!mat && (mat.status === "bereit" || mat.status === "entfaellt");
      return !s.ready && s.readyDate ? { ...o, av_ready: s.readyDate, material_ok } : material_ok ? { ...o, material_ok } : o;
    });
  const dateOf = (off) => addDays(monday0, Math.floor(off));
  const endDateOf = (off) => dateOf(off - 1e-6);
  const compute = (orders) => {
    const plan = buildPlanDeps(withAv(orders), rates, defaults, monday0, todayOff, free);
    const groups = buildGroups(orders, plan, monday0, settings.tight_days);
    return { plan, groups };
  };
  return { monday0, todayOff, free, rates, defaults, dateOf, endDateOf, compute, freeDays, today, checks };
}

// Arbeitsvorbereitung einer Position kurz: bereit oder die offenen Punkte (Material, Programm, Werkzeuge …)
const statusLabel = (id) => AV_STATUS.find((s) => s.id === id)?.label || id;
export function avOut(checks, o) {
  const s = avSummary(checks, o.id);
  const odooMaterial = /nicht verf/i.test(o.component_status || "") ? "Komponenten laut Odoo nicht verfügbar" : undefined;
  if (s.ready) return { bereit: true, ...(odooMaterial ? { odoo: odooMaterial } : {}) };
  return {
    bereit: false,
    offen: s.open.map((x) => [x.label, statusLabel(x.status), x.due ? `bis ${x.due}` : null, x.assignee, x.note ? `„${String(x.note).slice(0, 80)}“` : null].filter(Boolean).join(", ")),
    ...(odooMaterial ? { odoo: odooMaterial } : {}),
  };
}

const WAIT = { av: "Arbeitsvorbereitung (offene Punkte)", material: "Material aus dem Einkauf (Wareneingang)", dep: "vorheriger Arbeitsgang", earliest: "Start frühestens (Material/Werkzeug)" };

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
    av: ctx.checks ? avOut(ctx.checks, o) : undefined,
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
export function findPositions(orders, ref) {
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
      name: "plan_av_material",
      description:
        "Arbeitsvorbereitung und Material auf einen Blick: alle offenen Positionen, bei denen Material, Programm, Werkzeuge, Spannmittel, Prüfplan oder EMPB noch offen sind oder Odoo fehlende Komponenten meldet – mit Maschine, geplantem Start, Liefertermin, Zuständigem und Termin des offenen Punkts. Sortiert nach Start (dringendste zuerst). Erste Wahl für Fragen wie „Wo fehlt Material?“, „Was ist nicht bereit?“, „Was muss die AV als Nächstes erledigen?“.",
      inputSchema: {
        type: "object",
        properties: {
          nur_material: { type: "boolean", description: "nur Positionen, bei denen das Material offen ist oder in Odoo fehlt" },
          tage: { type: "integer", minimum: 1, maximum: 120, description: "nur Positionen mit Start in den nächsten N Tagen (Standard: alle)" },
        },
        additionalProperties: false,
      },
      run: ({ nur_material, tage } = {}) => {
        const inp = getInputs();
        const ctx = makeContext(inp);
        const { plan } = ctx.compute(inp.orders);
        const sched = new Map();
        plan.forEach((p) => p.items.forEach((i, idx) => i.scheduled && sched.set(i.o.id, { maschine: p.m.short, platz: idx + 1, start: ctx.dateOf(i.pastStart ?? i.start), ende: ctx.endDateOf(i.end), status: i.status })));
        const limit = tage ? addDays(inp.today, tage) : null;
        const rows = inp.orders
          .filter((o) => !o.done)
          .map((o) => {
            const av = avOut(inp.checks, o);
            const materialOffen = !av.bereit && av.offen.some((x) => x.startsWith("Material")) ;
            return { o, av, materialOffen: materialOffen || !!av.odoo, plan: sched.get(o.id) };
          })
          .filter((r) => !r.av.bereit || r.av.odoo)
          .filter((r) => !nur_material || r.materialOffen)
          .filter((r) => !limit || (r.plan && r.plan.start <= limit))
          .sort((a, b) => (a.plan?.start || "9999").localeCompare(b.plan?.start || "9999"));
        return {
          stand: new Date().toISOString(),
          heute: inp.today,
          anzahl: rows.length,
          davon_material_offen: rows.filter((r) => r.materialOffen).length,
          positionen: rows.slice(0, 60).map((r) => ({
            auftrag: groupLabelOf(r.o),
            fa: r.o.order_no || undefined,
            produkt: r.o.product || undefined,
            menge: r.o.quantity ?? undefined,
            ...(r.plan ? { maschine: r.plan.maschine, platz: r.plan.platz, start: r.plan.start, ende: r.plan.ende } : { maschine: r.o.machine || "noch keine", nicht_eingeplant: true }),
            liefertermin: r.o.due || undefined,
            material_offen: r.materialOffen,
            offen: r.av.offen,
            odoo: r.av.odoo,
          })),
          ...(rows.length > 60 ? { hinweis: `${rows.length - 60} weitere – mit tage eingrenzen` } : {}),
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

// Werkzeuge rund um "Heute zu tun" und die Freigaben. Talos liest und schlägt vor; ändern tut erst ein Mensch mit Freigabe.
export function kiTools(locals) {
  const need = (name) => {
    if (!locals[name]) throw new Error("Dieser Teil der App ist gerade nicht verfügbar.");
    return locals[name];
  };
  const kurz = (f) => ({
    id: f.id,
    art: f.art,
    titel: f.titel,
    bezug: f.bezug || undefined,
    quelle: f.quelle,
    erstellt: f.erstellt,
    text: f.text ? String(f.text).slice(0, 600) : undefined,
    ...(f.art === "av"
      ? {
          stunden: f.daten.hours || undefined,
          stunden_quelle: f.daten.hoursSrc || undefined,
          maschine: f.daten.machine ? MACHINES.find((m) => m.id === f.daten.machine.id)?.short : undefined,
          warnungen: f.daten.warnungen?.length ? f.daten.warnungen : undefined,
          hinweise: f.daten.hinweise?.length ? f.daten.hinweise : undefined,
          av_notizen: Object.keys(f.daten.notes || {}).length ? f.daten.notes : undefined,
        }
      : {}),
    ...(f.art === "plan" ? { einplanen: f.daten.einplanen?.length || 0, umstellen: f.daten.umgestellt || 0, vorher: f.daten.vorher, nachher: f.daten.nachher } : {}),
  });
  return [
    {
      name: "plan_heute",
      description:
        "„Heute zu tun“ in Planung und Arbeitsvorbereitung: offene Freigaben, Aufträge im Verzug ohne Kundeninfo, fehlende Kundenaufträge, überfällige AV, Positionen ohne Stunden oder ohne Maschine, Material nicht bestellt. Erste Wahl für „Was ist heute zu tun?“ und den Morgenbericht.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => need("heuteListe")(),
    },
    {
      name: "plan_vorschlag",
      description:
        "Rechnet den Planvorschlag für heute durch (neue Positionen einplanen, Reihenfolge verbessern, ohne Maschinenwechsel) und zeigt vorher/nachher: verspätete Aufträge, Verspätungstage, was eingeplant und was umgestellt würde. Speichert nichts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => {
        const { reihenfolge, stamp, ...rest } = need("freigaben").vorschau();
        return { simulation: true, hinweis: "Nur durchgerechnet. Übernommen wird erst, wenn ein Mensch den Planvorschlag in der App freigibt.", ...rest };
      },
    },
    {
      name: "freigaben_offen",
      description:
        "Alles, was die App vorbereitet hat und auf eine menschliche Freigabe wartet: AV-Pakete (Stunden, Maschine, Hinweise, Warnungen je Fertigungsauftrag), den Planvorschlag des Tages und Hinweise. Nur lesen.",
      inputSchema: { type: "object", properties: { art: { type: "string", enum: ["av", "plan", "hinweis"], description: "nur diese Art" } }, additionalProperties: false },
      run: ({ art } = {}) => {
        const list = need("freigaben").offen().filter((f) => !art || f.art === art);
        return { anzahl: list.length, freigaben: list.slice(0, 40).map(kurz), ...(list.length > 40 ? { hinweis: (list.length - 40) + " weitere" } : {}) };
      },
    },
    {
      name: "liefertermin_schaetzen",
      description:
        "Liefertermin für eine Anfrage oder ein Angebot: Wann könnten wir liefern, wenn der Auftrag heute käme? Rechnet mit der echten Planung je Maschine zwei Varianten: hinten anstellen (niemand verschiebt sich) und vorziehen (frühester Platz, ohne andere Aufträge zu verspäten). Liefertermin = Maschine fertig + extern + QS + 2 Werktage Puffer. Stunden angeben oder Zeichnungsnummer + Menge (dann aus der Kalkulation). Speichert nichts.",
      inputSchema: {
        type: "object",
        properties: {
          stunden: { type: "number", exclusiveMinimum: 0, description: "Maschinenstunden gesamt" },
          code: { type: "string", description: "Zeichnungsnummer, wenn die Stunden aus der Kalkulation kommen sollen" },
          menge: { type: "integer", minimum: 1 },
          extern_tage: { type: "integer", minimum: 0, maximum: 60, description: "Kalendertage extern (z. B. Eloxieren 7)" },
          material_tage: { type: "integer", minimum: 0, maximum: 60, description: "Werktage, bis das Material da ist" },
          qs: { type: "boolean", description: "Prüfung in der QS (Standard ja)" },
        },
        additionalProperties: false,
      },
      run: (args = {}) => need("liefertermin")(args),
    },
    {
      name: "extern_offen",
      description:
        "Extern & Wareneingang: offene Einkaufsbestellungen (Fremdfertigung, Lohnarbeit, Material), deren Wareneingang noch nicht validiert ist – mit Lieferant, zugesagtem und neuem Termin, überfällig seit, ob schon angefragt, welche Kundenaufträge daran hängen; dazu externe Arbeitsgänge (Strahlen, Schleifen, Härten …) ohne Bestellung und die Termintreue je Lieferant. Erste Wahl für „Was ist bei Lieferant X offen?“, „Welche Lieferungen sind überfällig?“, „Wo fehlt eine Bestellung?“.",
      inputSchema: {
        type: "object",
        properties: {
          lieferant: { type: "string", description: "nur dieser Lieferant (Teil des Namens)" },
          nur_handlungsbedarf: { type: "boolean", description: "nur überfällige, bald fällige und fehlende Bestellungen" },
        },
        additionalProperties: false,
      },
      run: async ({ lieferant, nur_handlungsbedarf } = {}) => {
        const d = await need("extern").get(false);
        if (!d.enabled) return { hinweis: "Odoo ist im Dashboard nicht angebunden." };
        const l = String(lieferant || "").toLowerCase();
        const offen = d.offen
          .filter((x) => !l || x.partner.toLowerCase().includes(l))
          .filter((x) => !nur_handlungsbedarf || x.aktion)
          .map((x) => ({
            bestellung: x.po,
            lieferant: x.lieferant,
            art: x.art,
            deren_referenz: x.partnerRef || undefined,
            wareneingang: x.wareneingang.join(", ") || undefined,
            zugesagt: x.zugesagt,
            termin_jetzt: x.termin,
            neuer_termin_vom_lieferanten: x.neuerTermin || undefined,
            status: x.status === "ueberfaellig" ? `${x.tage} Tage überfällig` : x.status,
            zu_tun: x.aktion || undefined,
            angefragt: x.angefragt ? `${x.angefragt}${x.angefragtVon ? " von " + x.angefragtVon : ""}` : undefined,
            positionen: x.lines.filter((p) => p.offen > 0).map((p) => `${p.offen} x ${p.name}`),
            kundenauftraege: x.betroffen.map((b) => `${b.source || b.ref}${b.customer ? " (" + b.customer + ")" : ""}${b.due ? ", Liefertermin " + b.due : ""}`),
            kunde_in_gefahr: x.kundeGefahr || undefined,
            kontakt: [x.email, x.phone].filter(Boolean).join(", ") || undefined,
          }));
        return {
          stand: d.stand,
          zahlen: d.zahlen,
          offen,
          bestellung_fehlt: d.fehlt.filter((x) => !nur_handlungsbedarf || x.dringend).slice(0, 30).map((x) => ({ fa: x.fa, auftrag: x.source, schritt: x.schritt, arbeitsplatz: x.arbeitsplatz, maschine_fertig: x.maschineFertig || undefined, dringend: x.dringend })),
          termintreue: l ? d.bewertung.filter((b) => b.lieferant.toLowerCase().includes(l)) : d.bewertung.slice(0, 10),
          hinweis: "Nur lesen. Nachfragen schickt ein Mensch (Knopf „Lieferant anfragen“ im Reiter Extern).",
        };
      },
    },
    {
      name: "freigabe_vorschlagen",
      description:
        "Legt einen Vorschlag oder Hinweis in die Freigabe-Liste der Planung (z. B. „FA01350 vor FA01347 ziehen, weil …“, „Kunde X wegen Verzug anrufen“). Ändert sonst nichts: Ein Mensch liest ihn, entscheidet und setzt ihn selbst um. Nur nutzen, wenn der Nutzer darum bittet oder etwas Wichtiges auffällt.",
      readOnly: false,
      inputSchema: {
        type: "object",
        properties: {
          titel: { type: "string", maxLength: 140, description: "kurz, was getan werden soll" },
          text: { type: "string", maxLength: 2000, description: "Begründung mit Zahlen aus den Werkzeugen" },
          bezug: { type: "string", description: "FA- oder Auftragsnummer, falls es um eine Position geht" },
        },
        required: ["titel", "text"],
        additionalProperties: false,
      },
      run: ({ titel, text, bezug }) => {
        const id = need("freigaben").hinweis({ titel, text, bezug });
        return { ok: true, id, hinweis: "In der Freigabe-Liste der Planung abgelegt. Geändert wurde nichts." };
      },
    },
  ];
}

// Minimaler MCP-Server (JSON-RPC über HTTP POST, zustandslos)
export default function registerTalosPlan(app, db, helpers) {
  // Zwei Schlüssel: TALOS_PLAN_SECRET (Talos: lesen, durchrechnen, Vorschläge ablegen) und PLAN_CHAT_SECRET (Planen im Chat:
  // zusätzlich ändern, jede Änderung erst nach Vorschau und ausdrücklichem Ja, server/chatPlan.js). Je mind. 24 Zeichen.
  const SECRET = process.env.TALOS_PLAN_SECRET || "";
  const CHAT = process.env.PLAN_CHAT_SECRET || "";
  if (SECRET.length < 24 && CHAT.length < 24) {
    console.log("Planungs-MCP aus: TALOS_PLAN_SECRET und PLAN_CHAT_SECRET fehlen");
    return;
  }
  const base = [...planTools(() => loadPlanInputs(db, helpers)), ...kiTools(app.locals)];
  const chat = [...base, ...chatTools(app, db, helpers)];
  const same = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const reply = (res, id, result) => res.json({ jsonrpc: "2.0", id, result });
  const error = (res, id, code, message) => res.json({ jsonrpc: "2.0", id, error: { code, message } });

  // Eigener Body-Parser: Die Route wird vor dem Passwortschutz der App angemeldet (Schutz hier über das Geheimnis)
  app.all("/mcp/:secret", express.json({ limit: "1mb" }), async (req, res) => {
    const isChat = CHAT.length >= 24 && same(req.params.secret, CHAT);
    if (!isChat && !(SECRET.length >= 24 && same(req.params.secret, SECRET))) return res.status(404).end();
    const tools = isChat ? chat : base;
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").end();
    const { id = null, method, params = {} } = req.body || {};
    if (id === null || id === undefined) return res.status(202).end(); // Benachrichtigung (z. B. initialized)
    if (method === "initialize") {
      return reply(res, id, {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "kratos-planung", version: "1.0.0" },
        instructions: isChat
          ? "Maschinenplanung der KRATOS Precision (Produktionsdashboard), Planen im Chat. Lesen und durchrechnen jederzeit. Werkzeuge, die etwas ändern (position_verschieben, stunden_setzen, liefertermin_setzen, position_fixieren, freigabe_entscheiden, lieferant_status_setzen), immer zuerst ohne bestaetigt aufrufen, dem Nutzer die Folgen nennen und erst nach seinem ausdrücklichen Ja mit bestaetigt: true ausführen. Mails an Lieferanten oder Kunden sendet die App nie."
          : "Maschinenplanung der KRATOS Precision (Produktionsdashboard). Lesen und durchrechnen; einzig freigabe_vorschlagen legt einen Vorschlag für einen Menschen ab, sonst wird nichts gespeichert. Quelle in Antworten: „Planung Produktionsdashboard, Stand <Zeit>“.",
      });
    }
    if (method === "ping") return reply(res, id, {});
    if (method === "tools/list") {
      return reply(res, id, { tools: tools.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, annotations: { readOnlyHint: readOnly !== false } })) });
    }
    if (method === "tools/call") {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return error(res, id, -32602, `Werkzeug ${params.name} unbekannt`);
      try {
        let text = JSON.stringify(await tool.run(params.arguments || {}));
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "…[gekürzt – Maschine angeben oder nur_auftraege nutzen]";
        return reply(res, id, { content: [{ type: "text", text }] });
      } catch (e) {
        return reply(res, id, { content: [{ type: "text", text: `Fehler: ${e.message}` }], isError: true });
      }
    }
    return error(res, id, -32601, `Methode ${method} nicht unterstützt`);
  });
  console.log(`Planungs-MCP an (${[SECRET.length >= 24 ? "Talos" : null, CHAT.length >= 24 ? "Chat" : null].filter(Boolean).join(", ")})`);
}
