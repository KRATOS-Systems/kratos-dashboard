// Die Abläufe der Klick-Demos. Jeder Schritt: Text für die Mitarbeiter, die Stelle zum Anklicken. Alles mit Demo-Daten aus dem Test-Odoo.

const post = (page, url, body) => page.evaluate((u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()), url, body);

// Fertigungsauftrag mit den vier Arbeitsgängen anlegen; state je Arbeitsgang
async function seedOrder(mock, { name, origin, qty = 10, states = {} }) {
  const [p] = await mock("mrp.production", "create", { vals_list: [{ name, product_id: 2901, state: "progress", origin, product_qty: qty, qty_producing: 0 }] });
  const ids = await mock("mrp.workorder", "create", {
    vals_list: [
      { name: "Programmierung", production_id: p, workcenter_id: 6, product_id: 2901, state: states.prog || "done", sequence: 0, qty_production: qty },
      { name: "Rüsten", production_id: p, workcenter_id: 16, product_id: 2901, state: states.ruesten || "done", sequence: 1, qty_production: qty },
      { name: "Fräsen", production_id: p, workcenter_id: 14, product_id: 2901, state: states.fraesen || "ready", sequence: 2, qty_production: qty },
      { name: "Qualitätssicherung", production_id: p, workcenter_id: 5, product_id: 2901, state: states.qs || "blocked", sequence: 3, qty_production: qty },
    ],
  });
  return { production: p, prog: ids[0], ruesten: ids[1], fraesen: ids[2], qs: ids[3] };
}

// Ein früherer, erledigter Auftrag desselben Teils mit Laufzeiten (der Vorschlag beim Wiederholteil)
async function seedHistory(mock) {
  const [p] = await mock("mrp.production", "create", { vals_list: [{ name: "FA09000", product_id: 2901, state: "done", origin: "A09000", product_qty: 10 }] });
  await mock("mrp.workorder", "create", { vals_list: [{ name: "Fräsen", production_id: p, workcenter_id: 14, product_id: 2901, state: "done", sequence: 2 }] });
  const note = (t) => ({ model: "mrp.production", res_id: p, message_type: "comment", author_id: 3, body: `<p>${t}</p>`, date: "2026-10-15 09:00:00", record_name: "FA09000" });
  await mock("mail.message", "create", {
    vals_list: [
      note("<b>Aufspannungen (DMU 40 EVO):</b> 2 (Aurel Rama, 15.10.2026)"),
      note("<b>Laufzeit Aufspannung 1 (DMU 40 EVO):</b> 7:30 Min:Sek für 1 Teil = 7:30 je Stück (Aurel Rama, 15.10.2026)"),
      note("<b>Laufzeit Aufspannung 2 (DMU 40 EVO):</b> 12:00 Min:Sek für 2 Teile = 6:00 je Stück (Aurel Rama, 15.10.2026)"),
    ],
  });
}

export const DEMOS = [
  {
    id: "fraesen",
    title: "Fräsen beenden und Laufzeit eintragen",
    text: "Die Maschine ist fertig: Lauf beenden, Anzahl der Aufspannungen, Programmlaufzeit von der Steuerung eintragen und das Fräsen fertig melden.",
    async run({ page, rec, mock, APP, sleep }) {
      await mock("mrp.workcenter.productivity", "write", { ids: [4157], vals: { date_end: "2026-06-11 14:00:00" } }); // altes Testbeispiel schließen, damit die Aufnahme sauber ist
      await seedHistory(mock);
      const o = await seedOrder(mock, { name: "FA09001", origin: "A09001", states: { fraesen: "progress" } });
      await page.goto(`${APP}/#platz`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.body.innerText.includes("Wer bist du"), { timeout: 15000 });
      await rec.step("Öffne „Mein Arbeitsplatz“ und tippe auf deinen Namen.", "Nino Posset");
      await rec.step("Gib deine vierstellige PIN ein und tippe auf das grüne Häkchen.", "4", { click: false });
      for (const d of "4444") {
        const b = await page.evaluate((d) => {
          const el = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === d && x.getBoundingClientRect().width > 1);
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }, d);
        await rec.click(b);
        await sleep(120);
      }
      const go = await rec.findSel("button.go");
      await rec.click(go);
      await page.waitForFunction(() => document.body.innerText.includes("Angemeldet als"), { timeout: 8000 }).catch(async () => { throw new Error("Anmeldung klappt nicht: " + (await page.evaluate(() => document.body.innerText.slice(0, 400)))); });
      await sleep(800);
      // Das Fräsen läuft schon (so wie nach dem Start am Vormittag)
      console.log("start:", JSON.stringify(await post(page, "/api/bde/act", { action: "start", workorderId: o.fraesen })));
      // Der Lauf hat vor drei Stunden begonnen, so wie im Alltag
      const line = await mock("mrp.workcenter.productivity", "search_read", { domain: [["workorder_id", "=", o.fraesen]], fields: ["id"] });
      await mock("mrp.workcenter.productivity", "write", { ids: [line[0].id], vals: { date_start: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 19).replace("T", " ") } });
      console.log("ampel:", JSON.stringify(await page.evaluate(() => fetch("/api/maschinen/ampel?fresh=1").then((r) => r.json()).then((d) => d.machines.dmu40))));
      await page.reload({ waitUntil: "networkidle0" });
      await sleep(1500);
      await rec.step("Das Fräsen läuft nebenher. Du siehst es unten bei „Maschinenläufe“. Ist die Maschine fertig, tippe auf „Beenden“.", "Beenden");
      await rec.step("„Jetzt beenden“ nimmt die aktuelle Uhrzeit. War die Maschine schon früher fertig, trägst du darunter die Uhrzeit ein.", "Jetzt beenden");
      await rec.step("Als Erstes: Wie viele Aufspannungen hat dieses Teil? Beim letzten Mal waren es 2 (hervorgehoben).", "2");
      await rec.step("Ist die erste Aufspannung fertig, tippe auf „Ja“.", "Ja");
      await rec.step("Wähle die Aufspannung, deren Zeit du eintragen willst.", { sel: ".lzgrid button", nth: 0 });
      await rec.step("Bei einem Teil, das ihr schon gefertigt habt, steht die letzte Zeit als Vorschlag da. Ist das Programm gleich geblieben, tippe auf „Laufzeit unverändert“.", "Laufzeit unverändert");
      await sleep(600);
      await rec.step("Die zweite Aufspannung trägst du genauso ein. Du findest sie auf „Mein Arbeitsplatz“ unter „Noch nicht fertig gemeldet“.", "Eintragen");
      await rec.step("Bestätige: Die Aufspannung ist fertig.", "Ja");
      await rec.step("Hat sich das Programm geändert, tippe auf „Andere Zeit eingeben“.", "Andere Zeit eingeben");
      await rec.type(".lztime input", "11", 0);
      await rec.type(".lztime input", "40", 1);
      await rec.step("Trage die Programmlaufzeit ein, genau wie die Steuerung der Maschine sie anzeigt: Minuten und Sekunden eines vollen Durchlaufs.", { sel: ".lztime" }, { click: false });
      await rec.step("Der Haken „Programm wurde geändert“ ist schon gesetzt, weil du eine andere Zeit eingibst. Lass ihn so, dann sieht die Kalkulation, dass die Zeit neu ist.", "Programm wurde geändert", { click: false });
      await rec.step("Tippe auf „Speichern“.", "Speichern");
      await rec.step("Sind alle Aufspannungen eingetragen, melde das Fräsen fertig. Damit gibt Odoo die QS frei.", "Fräsen fertig melden");
      await rec.step("Kommt kein weiterer Arbeitsschritt auf einer anderen Maschine dazu, tippe auf „Nein, fertig“.", "Nein, fertig");
    },
  },
];
