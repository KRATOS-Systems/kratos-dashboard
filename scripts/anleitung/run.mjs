// Nimmt die Klick-Demos in der Testumgebung auf (nur Demo-Daten). Aufruf: node run.mjs [demo ...]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { startEnv, APP, PROJECT, sleep } from "./env.mjs";
import { Rec, saveIndex } from "./lib.mjs";
import { DEMOS } from "./demos.mjs";

const OUT = path.join(PROJECT, "public", "anleitung");
const want = process.argv.slice(2);
const env = await startEnv();
const done = [];
try {
  for (const demo of DEMOS) {
    if (want.length && !want.includes(demo.id)) continue;
    console.log("Demo", demo.id);
    const page = await env.browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    const rec = new Rec(page, OUT, demo);
    try {
      await demo.run({ page, rec, mock: env.mock, APP, sleep });
      done.push(rec.finish());
      console.log("  ", rec.steps.length, "Schritte");
    } catch (err) {
      console.error("  FEHLER:", err.message);
      console.error((await fetch("http://localhost:8091/__log").then((r) => r.json()).catch(() => [])).slice(-10).map((l) => l.call).join(String.fromCharCode(10)));
      await page.screenshot({ path: path.join(PROJECT, "public", "anleitung", `_fehler_${demo.id}.png`) }).catch(() => {});
      process.exitCode = 1;
    }
    await page.close();
  }
  // vorhandene Demos aus demos.json behalten, die nicht neu aufgenommen wurden
  let old = [];
  const idx = path.join(OUT, "demos.json");
  if (existsSync(idx)) old = JSON.parse(readFileSync(idx, "utf8")).demos;
  const byId = new Map(old.map((d) => [d.id, d]));
  done.forEach((d) => byId.set(d.id, d));
  const order = DEMOS.map((d) => d.id);
  saveIndex(OUT, [...byId.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)));
} finally {
  await env.stop();
}
