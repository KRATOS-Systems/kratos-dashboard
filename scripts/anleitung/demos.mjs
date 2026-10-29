// Die Abläufe der Klick-Demos, in der Reihenfolge, in der ein Auftrag durch die Firma läuft.
// Jeder Schritt: Text für die Mitarbeiter und die Stelle zum Anklicken. Alles mit Demo-Daten aus dem Test-Odoo.

const post = (page, url, body) => page.evaluate((u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()), url, body);
const DIALOG = "[role=dialog], .modal";

// Fertigungsauftrag mit den vier Arbeitsgängen anlegen
async function seedOrder(mock, { name, origin, qty = 10, states = {}, fraesenMin = 0, due = "2026-11-20 07:00:00" }) {
  const [p] = await mock("mrp.production", "create", { vals_list: [{ name, product_id: 2901, state: "progress", origin, product_qty: qty, qty_producing: 0, date_deadline: due }] });
  const ids = await mock("mrp.workorder", "create", {
    vals_list: [
      { name: "Programmierung", production_id: p, workcenter_id: 6, product_id: 2901, state: states.prog || "done", sequence: 0, qty_production: qty },
      { name: "Rüsten", production_id: p, workcenter_id: 16, product_id: 2901, state: states.ruesten || "done", sequence: 1, qty_production: qty },
      { name: "Fräsen", production_id: p, workcenter_id: 14, product_id: 2901, state: states.fraesen || "ready", sequence: 2, qty_production: qty, duration_expected: fraesenMin },
      { name: "Qualitätssicherung", production_id: p, workcenter_id: 5, product_id: 2901, state: states.qs || "blocked", sequence: 3, qty_production: qty },
    ],
  });
  return { production: p, prog: ids[0], ruesten: ids[1], fraesen: ids[2], qs: ids[3] };
}

// Früherer, erledigter Auftrag desselben Teils mit Laufzeiten (der Vorschlag beim Wiederholteil)
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

// Anzahl und Laufzeiten einer Fertigung schon eingetragen, damit die Demo kurz bleibt
async function seedNotes(mock, production, anzahl) {
  const note = (t) => ({ model: "mrp.production", res_id: production, message_type: "comment", author_id: 3, body: `<p>${t}</p>`, date: "2026-10-29 08:00:00", record_name: "FA" });
  const rows = [note(`<b>Aufspannungen (DMU 40 EVO):</b> ${anzahl} (Nino Posset, 29.10.2026)`)];
  for (let i = 1; i <= anzahl; i++) rows.push(note(`<b>Laufzeit Aufspannung ${i} (DMU 40 EVO):</b> 7:30 Min:Sek für 1 Teil = 7:30 je Stück (Nino Posset, 29.10.2026)`));
  await mock("mail.message", "create", { vals_list: rows });
}

// Die Arbeit läuft schon seit ein paar Stunden, so wie im Alltag
async function backdate(mock, workorderId, hoursAgo) {
  const line = await mock("mrp.workcenter.productivity", "search_read", { domain: [["workorder_id", "=", workorderId]], fields: ["id"] });
  await mock("mrp.workcenter.productivity", "write", { ids: [line[line.length - 1].id], vals: { date_start: new Date(Date.now() - hoursAgo * 3600e3).toISOString().slice(0, 19).replace("T", " ") } });
}
async function startRun(page, mock, workorderId, hoursAgo = 3) {
  const r = await post(page, "/api/bde/act", { action: "start", workorderId });
  if (!r.ok) throw new Error("Start nicht möglich: " + JSON.stringify(r));
  await backdate(mock, workorderId, hoursAgo);
}

// altes Testbeispiel schließen und Nino als anwesend eintragen, damit die Aufnahmen sauber sind
async function closeOldRun(mock) {
  await mock("mrp.workcenter.productivity", "write", { ids: [4157], vals: { date_end: "2026-06-11 14:00:00" } });
  await mock("hr.attendance", "create", { vals_list: [{ employee_id: 11, check_in: new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 19).replace("T", " "), check_out: false, worked_hours: 0 }] });
}
// wartet, bis der Dialog zu ist (die Buchung in Odoo dauert einen Moment)
const closed = (page, sleep) => page.waitForFunction(() => !document.querySelector(".modal.lz"), { timeout: 20000 }).then(() => sleep(1200));

// Angemeldet auf Mein Arbeitsplatz, ohne dass Schritte aufgenommen werden
async function enter(page, rec, APP, name = "Nino Posset", pin = "4444") {
  await page.goto(`${APP}/#platz`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.body.innerText.includes("Wer bist du"), { timeout: 15000 });
  await rec.login(name, pin);
}
async function reload(page, sleep) {
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(1500);
}

// Aufträge wie aus dem Einkauf: erst der erste Abgleich (merkt sich Altes), dann neue Fertigungsaufträge, dann der Abgleich holt sie
async function importOrders(page, mock, list) {
  await post(page, "/api/odoo/sync", { dryRun: false });
  for (const o of list) await seedOrder(mock, { ...o, states: { prog: "ready", ruesten: "blocked", fraesen: "blocked" } });
  await post(page, "/api/odoo/sync", { dryRun: false });
  const orders = (await page.evaluate(() => fetch("/api/orders").then((r) => r.json()))).orders;
  for (const o of orders.filter((x) => x.odoo_ref === "FA01307")) await page.evaluate((id) => fetch(`/api/orders/${id}`, { method: "DELETE" }), o.id); // Testbeispiel aus dem Mock
}

export const DEMOS = [
  {
    id: "av",
    title: "1. Arbeitsvorbereitung: Auftrag vorbereiten",
    text: "Neue Aufträge aus Odoo prüfen: Material, Programm, Werkzeuge, Spannmittel und Prüfplan auf „bereit“ setzen, bevor gefertigt wird.",
    async run({ page, rec, mock, APP, sleep }) {
      await page.goto(`${APP}/#av`, { waitUntil: "networkidle0" });
      await importOrders(page, mock, [
        { name: "FA09201", origin: "A09201", qty: 10, fraesenMin: 300 },
        { name: "FA09202", origin: "A09201", qty: 4, fraesenMin: 150 },
      ]);
      await reload(page, sleep);
      await rec.step("Die Arbeitsvorbereitung kommt zuerst. Neue Aufträge aus Odoo erscheinen hier mit dem Zeichen „NEU“. Hier prüfst du, ob alles bereit ist, bevor gefertigt wird.", "A09201", { click: false, self: true });
      await rec.step("Pro Auftrag gibt es sechs Punkte: Material, Programm, Werkzeuge, Spannmittel, Prüfplan und EMPB. Unter jedem Status steht, wer zuständig ist.", "Material", { click: false, self: true });
      await rec.step("Ein Klick auf den Status schaltet ihn weiter: „offen“, „in Arbeit“, „bereit“. Das Material ist bestellt: Tippe auf „offen“.", "offen");
      await rec.step("Jetzt steht dort „in Arbeit“. Ist das Material da, tippe noch einmal.", "in Arbeit");
      await rec.step("„bereit“ heißt: erledigt. Genauso gehst du die anderen Punkte durch.", "bereit", { click: false });
      await rec.step("Ein Klick auf die Zeile öffnet die Details mit Zeichnung, Termin, Zuständigem und Notiz.", "A09201", { click: false, self: true });
      await rec.step("Die Spalte „Planung“ zeigt, auf welcher Maschine der Auftrag läuft. Solange dort „nicht eingeplant“ steht, geht es in der Planung weiter.", "Planung", { click: false, self: true });
    },
  },
  {
    id: "planung",
    title: "2. Planung: Maschine und Arbeitsgänge gleich festlegen",
    text: "Neue Aufträge einplanen: Stunden prüfen, Maschine wählen und Arbeitsgänge für mehrere Maschinen von Anfang an anlegen, auch in Odoo.",
    async run({ page, rec, mock, APP, sleep }) {
      await page.goto(`${APP}/#planung`, { waitUntil: "networkidle0" });
      await importOrders(page, mock, [
        { name: "FA09201", origin: "A09201", qty: 10, fraesenMin: 300 },
        { name: "FA09202", origin: "A09201", qty: 4, fraesenMin: 150 },
      ]);
      await reload(page, sleep);
      await rec.step("Hier planst du. Das Wichtigste vorab: Lege die Maschine und die Arbeitsgänge am besten gleich fest, bevor die Fertigung beginnt. Nachträglich geht es auch, ist aber umständlicher.", { sel: ".tl" }, { click: false });
      await rec.step("Neue Aufträge aus Odoo liegen unter „Noch nicht eingeplant“.", "Noch nicht eingeplant", { click: false });
      await rec.step("Die Stunden kommen aus Odoo (Arbeitsplan der Stückliste). Stimmen sie nicht oder fehlen sie, trage ungefähre Gesamtstunden selbst ein.", { sel: 'input[type="number"]', nth: 0 }, { click: false });
      await rec.step("Wähle die Maschine, auf der der Auftrag laufen soll.", "DMU 40 EVO", { nth: 1 });
      await sleep(600);
      await rec.step("Der Auftrag steht jetzt im Zeitstrahl bei der Maschine. Mit dem Ziehen des Balkens verschiebst du ihn.", { sel: ".bar", nth: 0 }, { click: false });
      await rec.step("Braucht ein Teil mehrere Maschinen, etwa Seite 1 auf der einen und Seite 2 auf der anderen? Dann lege die „Arbeitsgänge“ gleich hier an.", "Arbeitsgänge");
      await rec.type(".agrow input[type=text]", "Seite 1", 0);
      await rec.type(".agrow input[type=number]", "1.5", 0);
      await rec.type(".agrow input[type=text]", "Seite 2", 1);
      await rec.type(".agrow input[type=number]", "1", 1);
      await rec.step("Jeder Arbeitsgang bekommt eine Bezeichnung, eine Maschine und Stunden. Sie laufen nacheinander, von oben nach unten.", { sel: ".agrow", nth: 0 }, { click: false });
      await rec.step("Mit dem Haken „Auch in Odoo anlegen“ entstehen Rüsten und Fräsen für die weitere Maschine gleich in Odoo, vor der QS. So muss während der Fertigung nichts nachgetragen werden.", "Auch in Odoo anlegen", { click: false, starts: true });
      await rec.step("Tippe auf „Anlegen“.", "Anlegen");
      await sleep(1500);
      await rec.step("Beide Arbeitsgänge stehen im Zeitstrahl, jeder bei seiner Maschine. Die Fertigung kann beginnen.", { sel: ".tl" }, { click: false });
    },
  },
  {
    id: "stempeln",
    title: "3. Anmelden und stempeln",
    text: "Mit der PIN anmelden, eine Arbeit starten, unterbrechen und beenden. So rechnet Odoo die Zeit richtig ab.",
    async run({ page, rec, mock, APP, sleep }) {
      await closeOldRun(mock);
      await seedOrder(mock, { name: "FA09101", origin: "A09101", qty: 5, states: { prog: "ready", ruesten: "blocked", fraesen: "blocked" } });
      await page.goto(`${APP}/#platz`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.body.innerText.includes("Wer bist du"), { timeout: 15000 });
      await rec.step("Öffne „Mein Arbeitsplatz“ und tippe auf deinen Namen.", "Nino Posset");
      await rec.step("Gib deine vierstellige PIN ein und tippe auf das grüne Häkchen.", "4", { click: false });
      await rec.enterPin("4444");
      await sleep(1200);
      await rec.step("Das ist deine Seite. Oben siehst du die Maschinenampel, darunter, woran du gerade arbeitest. Noch läuft keine Zeit.", "Keine Zeit läuft", { click: false });
      await rec.step("Um eine Arbeit zu starten, tippe auf „Wechseln“.", "Wechseln");
      await rec.step("Suche den Auftrag über „Suchen“. Unter „Zuletzt“ und „Als Nächstes“ stehen die Aufträge, an denen du zuletzt gearbeitet hast oder die als Nächstes kommen.", "Suchen", { scope: DIALOG });
      await rec.type(`${DIALOG.split(", ").map((s) => s + " input:not([type=checkbox])").join(", ")}`, "FA09101", 0);
      await sleep(1500);
      await rec.step("Tippe auf den Arbeitsgang, den du anfängst. Hier: die Programmierung.", "FA09101", { scope: DIALOG, nth: 0 });
      await sleep(1500);
      await rec.step("Jetzt läuft deine Zeit auf diesem Arbeitsgang. Die Uhr zählt mit.", "Programmierung", { click: false });
      await rec.step("Musst du kurz weg, tippe auf „Pause“. Danach heißt der Knopf „Weiter“ und setzt die Zeit am selben Arbeitsgang fort.", "Pause", { click: false });
      await rec.step("Bist du mit dem Arbeitsgang fertig oder hörst du auf, tippe auf „Stopp“. Stoppe immer, bevor du etwas anderes anfängst oder gehst.", "Stopp");
      await rec.step("Danach fragt dich die App, ob der Arbeitsgang fertig ist. Wie du antwortest, zeigen die nächsten Anleitungen.", "Ja", { click: false });
    },
  },
  {
    id: "programmierung",
    title: "4. Programmierung fertig und Anzahl der Aufspannungen",
    text: "Die Programmierung abschließen und festhalten, wie viele Aufspannungen das Teil braucht.",
    async run({ page, rec, mock, APP, sleep }) {
      await closeOldRun(mock);
      await seedHistory(mock);
      const o = await seedOrder(mock, { name: "FA09102", origin: "A09102", qty: 5, states: { prog: "ready", ruesten: "blocked", fraesen: "blocked" } });
      await enter(page, rec, APP);
      await startRun(page, mock, o.prog, 2);
      await reload(page, sleep);
      await rec.step("Du programmierst. Bist du fertig, tippe auf „Stopp“.", "Stopp");
      await rec.step("Die App fragt: „Programmierung fertig?“ Ja heißt: Das Programm ist fertig. Dann gibt Odoo den nächsten Arbeitsgang frei.", "Ja");
      await rec.step("Jetzt: Wie viele Aufspannungen braucht das Teil? Beim letzten Mal waren es 2, das ist hervorgehoben. Bei mehr als sechs trägst du die Zahl bei „Mehr“ ein.", "2");
      await closed(page, sleep);
      await rec.step("Fertig. Die Programmierung ist in Odoo abgeschlossen, und die Anzahl der Aufspannungen steht im Fertigungsauftrag. Beim Fräsen siehst du sie wieder.", "Mein Arbeitsplatz", { click: false, nth: 0 });
    },
  },
  {
    id: "ruesten",
    title: "5. Rüsten fertig",
    text: "Das Rüsten stempeln und beenden. Ja, wenn die Maschine bereit zum Fräsen ist.",
    async run({ page, rec, mock, APP, sleep }) {
      await closeOldRun(mock);
      const o = await seedOrder(mock, { name: "FA09103", origin: "A09103", qty: 5, states: { prog: "done", ruesten: "ready", fraesen: "blocked" } });
      await enter(page, rec, APP);
      await startRun(page, mock, o.ruesten, 1);
      await reload(page, sleep);
      await rec.step("Das Rüsten stempelst du wie jede andere Arbeit. Ist die Maschine bereit, tippe auf „Stopp“.", "Stopp");
      await rec.step("Die App fragt: „Rüsten fertig?“ Tippe auf „Ja“, wenn die Maschine bereit zum Fräsen ist. Ist noch etwas zu tun, tippe auf „Nein“ und mach später weiter.", "Ja");
      await closed(page, sleep);
      await rec.step("Das Rüsten ist in Odoo abgeschlossen, und das Fräsen ist freigegeben. Jetzt kann es auf der Maschine losgehen.", "Mein Arbeitsplatz", { click: false, nth: 0 });
    },
  },
  {
    id: "fraesen",
    title: "6. Fräsen beenden und Laufzeit eintragen",
    text: "Die Maschine ist fertig: Lauf beenden, Anzahl der Aufspannungen, Programmlaufzeit von der Steuerung eintragen und das Fräsen fertig melden.",
    async run({ page, rec, mock, APP, sleep }) {
      await closeOldRun(mock);
      await seedHistory(mock);
      const o = await seedOrder(mock, { name: "FA09001", origin: "A09001", states: { fraesen: "progress" } });
      await enter(page, rec, APP);
      await startRun(page, mock, o.fraesen, 3);
      await reload(page, sleep);
      await rec.step("Das Fräsen läuft nebenher. Du siehst es unten bei „Maschinenläufe“. Ist die Maschine fertig, tippe auf „Beenden“.", "Beenden");
      await rec.step("„Jetzt beenden“ nimmt die aktuelle Uhrzeit. War die Maschine schon früher fertig, trägst du darunter die Uhrzeit ein.", "Jetzt beenden");
      await rec.step("Als Erstes: Wie viele Aufspannungen hat dieses Teil? Beim letzten Mal waren es 2 (hervorgehoben).", "2");
      await rec.step("Ist die erste Aufspannung fertig, tippe auf „Ja“.", "Ja");
      await rec.step("Wähle die Aufspannung, deren Zeit du eintragen willst.", { sel: ".lzgrid button", nth: 0 });
      await rec.step("Bei einem Teil, das ihr schon gefertigt habt, steht die letzte Zeit als Vorschlag da. Ist das Programm gleich geblieben, tippe auf „Laufzeit unverändert“.", "Laufzeit unverändert");
      await closed(page, sleep);
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
  {
    id: "schritt",
    title: "7. Weiterer Arbeitsschritt auf einer anderen Maschine",
    text: "Die Ausnahme: Zeigt sich erst beim Fräsen, dass eine zweite Maschine nötig ist, legst du den Arbeitsschritt nachträglich an.",
    async run({ page, rec, mock, APP, sleep }) {
      await closeOldRun(mock);
      const o = await seedOrder(mock, { name: "FA09104", origin: "A09104", qty: 5, states: { fraesen: "progress" } });
      await seedNotes(mock, o.production, 1);
      await enter(page, rec, APP);
      await startRun(page, mock, o.fraesen, 3);
      await reload(page, sleep);
      await rec.step("Besser ist es, alle Maschinen und Arbeitsgänge gleich in der Planung festzulegen. Zeigt sich erst beim Fräsen, dass eine zweite Maschine nötig ist, geht es auch jetzt. Beende zuerst den Lauf.", "Beenden");
      await rec.step("Tippe auf „Jetzt beenden“.", "Jetzt beenden");
      await rec.step("Die Laufzeit dieser Aufspannung ist schon eingetragen. Melde das Fräsen fertig.", "Fräsen fertig melden");
      await rec.step("Jetzt fragt die App: Kommt noch ein weiterer Arbeitsschritt auf einer anderen Maschine dazu? Tippe auf „Weiterer Arbeitsschritt“.", "Weiterer Arbeitsschritt");
      await rec.step("Wähle die Maschine, auf der es weitergeht.", "DMU 50", { scope: DIALOG });
      await rec.type(".lztime input", "1.5", 0);
      await rec.type(".lztime input", "4", 1);
      await rec.step("Trage ein, wie viele Stunden du fürs Rüsten und fürs Fräsen planst. Das ist freiwillig, hilft aber der Planung.", { sel: ".lztime" }, { click: false });
      await rec.step("Tippe auf „Anlegen“. Die App legt in Odoo Rüsten und Fräsen für diese Maschine an, vor der QS.", "Anlegen");
      await closed(page, sleep);
      await rec.step("Fertig. Auf der neuen Maschine stempelst du wie gewohnt. Laufzeit und Aufspannungen zählen dort wieder bei 1.", "Mein Arbeitsplatz", { click: false, nth: 0 });
    },
  },
  {
    id: "qs",
    title: "8. QS fertig und Fertigungsauftrag abschließen",
    text: "Die Qualitätssicherung beenden und den Fertigungsauftrag in Odoo abschließen. Das Material wird abgebucht und das fertige Teil eingelagert.",
    async run({ page, rec, mock, APP, sleep }) {
      await closeOldRun(mock);
      const o = await seedOrder(mock, { name: "FA09105", origin: "A09105", qty: 5, states: { prog: "done", ruesten: "done", fraesen: "done", qs: "ready" } });
      await enter(page, rec, APP);
      await startRun(page, mock, o.qs, 1);
      await reload(page, sleep);
      await rec.step("Die QS ist der letzte Arbeitsgang. Bist du mit der Prüfung fertig, tippe auf „Stopp“.", "Stopp");
      await rec.step("Die App fragt: „Qualitätssicherung fertig?“ Ja, wenn das Teil geprüft und in Ordnung ist.", "Ja");
      await rec.step("Sind alle Arbeitsgänge fertig, fragt die App, ob der Fertigungsauftrag abgeschlossen wird. Dabei bucht Odoo das Material ab und das fertige Teil ins Lager. Erst jetzt ist der Auftrag wirklich fertig.", "Fertigungsauftrag abschließen");
      await closed(page, sleep);
      await rec.step("Der Auftrag ist abgeschlossen. Fragt Odoo etwas zurück, sagt dir die App, dass du ihn in Odoo abschließen musst. Dann gib der Leitung Bescheid.", "Mein Arbeitsplatz", { click: false, nth: 0 });
    },
  },
  {
    id: "ampel",
    title: "9. Maschinenampel und beim Gehen",
    text: "Die Ampel zeigt, was an den Maschinen läuft. Läuft eine Maschine ohne dich weiter und ist fertig, beendest du den Lauf.",
    async run({ page, rec, mock, APP, sleep }) {
      await closeOldRun(mock);
      const a = await seedOrder(mock, { name: "FA09106", origin: "A09106", qty: 8, states: { fraesen: "progress" } });
      const b = await seedOrder(mock, { name: "FA09107", origin: "A09107", qty: 3, states: { ruesten: "progress", fraesen: "blocked" } });
      // Frank fräst auf der DMU 40 EVO, Aurel rüstet auf der M1 (Arbeitsplatz "DMG M1 Rüsten")
      await mock("mrp.workorder", "write", { ids: [b.ruesten], vals: { workcenter_id: 17 } });
      await mock("mrp.workorder", "start_employee", { ids: [a.fraesen], employee_id: 3 });
      await mock("mrp.workorder", "start_employee", { ids: [b.ruesten], employee_id: 2 });
      await backdate(mock, a.fraesen, 5);
      await backdate(mock, b.ruesten, 1);
      await enter(page, rec, APP);
      await reload(page, sleep);
      await rec.step("Oben siehst du für jede Maschine eine Ampel. Grün heißt: Es läuft ein Fräsen. Darunter steht, welcher Auftrag läuft und wer ihn gestartet hat.", "DMU 40 EVO", { click: false, nth: 0 });
      await rec.step("Gelb heißt: Es wird gerüstet, aber es läuft noch kein Fräsen.", "M1", { click: false, nth: 0 });
      await rec.step("Rot heißt: Nichts ist gestempelt, obwohl Arbeitszeit ist und Arbeit für die Maschine wartet. Keine Lampe heißt: Nichts zu tun, oder es ist Nacht und Wochenende.", "DMU 50", { click: false, nth: 0 });
      await rec.step("Tippe auf eine Ampel, um zu sehen, was dort läuft.", "DMU 40 EVO", { nth: 0 });
      await rec.step("Ist die Maschine fertig und der Kollege schon gegangen, tippe auf „Beenden“. Das darf jeder angemeldete Mitarbeiter.", "Beenden", { scope: DIALOG });
      await rec.step("„Jetzt beenden“ nimmt die aktuelle Uhrzeit. War die Maschine schon früher fertig, trägst du die Uhrzeit ein.", "Jetzt beenden", { scope: DIALOG });
      await sleep(1500);
      await rec.step("Die Ampel zeigt jetzt: Nichts zu tun. Tippe auf „Schließen“.", "Schließen", { scope: DIALOG });
      await sleep(800);
      await rec.step("Beim Gehen: Stoppe deine Arbeit, schau auf die Ampel und beende einen fertigen Lauf. Läuft die Maschine bewusst weiter, zum Beispiel nachts, lass sie laufen. Deine Arbeitszeit stempelst du weiter am Odoo-Kiosk.", "DMU 40 EVO", { click: false, nth: 0 });
    },
  },
  {
    id: "leitung",
    title: "10. Für die Leitung: Zur Rechnung bereit",
    text: "Alle Teile eines Kundenauftrags sind gefertigt und Odoo sieht noch etwas zu berechnen: Die App zeigt es an.",
    async run({ page, rec, mock, APP, sleep }) {
      await closeOldRun(mock);
      const [cust] = await mock("res.partner", "create", { vals_list: [{ name: "Beispiel Maschinenbau GmbH" }] });
      await mock("sale.order", "create", { vals_list: [{ name: "A09301", state: "sale", invoice_status: "to invoice", invoice_count: 0, delivery_status: "full", partner_id: cust, amount_total: 4119.78 }] });
      await seedOrder(mock, { name: "FA09301", origin: "A09301", states: { prog: "done", ruesten: "done", fraesen: "done", qs: "done" } });
      await mock("sale.order", "create", { vals_list: [{ name: "A09302", state: "sale", invoice_status: "to invoice", invoice_count: 1, delivery_status: "partial", partner_id: cust, amount_total: 1250.5 }] });
      await seedOrder(mock, { name: "FA09302", origin: "A09302", states: { prog: "done", ruesten: "done", fraesen: "done", qs: "done" } });
      await enter(page, rec, APP, "Frank Häckl", "3333");
      await reload(page, sleep);
      await rec.step("Als Leitung siehst du auf „Mein Arbeitsplatz“ den Abschnitt „Zur Rechnung bereit“. Dort stehen Kundenaufträge, bei denen alle Teile gefertigt sind und Odoo noch etwas zu berechnen sieht.", "Zur Rechnung bereit", { click: false, starts: true });
      await rec.step("Pro Auftrag siehst du Kunde, Anzahl der Teile, Lieferstatus, Betrag und wie viele Rechnungen es schon gibt. „In Odoo öffnen“ führt direkt zum Auftrag.", "In Odoo öffnen", { click: false });
      await rec.step("Die App liefert und berechnet nichts, sie zeigt es nur an. Ist in Odoo alles berechnet, verschwindet der Eintrag von selbst.", "Zur Rechnung bereit", { click: false, starts: true });
      await rec.step("Auf der Team-Tafel siehst du, wer woran arbeitet. Vergessene Buchungen und zu lange Maschinenläufe meldet dir die App als Hinweis.", "Team", { scope: "nav" });
    },
  },
];
