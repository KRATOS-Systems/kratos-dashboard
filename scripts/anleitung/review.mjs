// Übersichtsbögen der Demos zum Prüfen: Bild mit markierter Stelle und Text je Schritt.
import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const ROOT = "C:/Users/Alexander.Meimeteas/Desktop/Claude/Claude Code/Web App/kratos-dashboard/public/anleitung";
const OUT = "C:/Users/ALEXAN~1.MEI/AppData/Local/Temp/claude/C--Users-Alexander-Meimeteas-Desktop-Claude-Claude-Code-Web-App/d08e5e31-2b74-4c42-a574-15933d4b8d37/scratchpad/rec";
const data = JSON.parse(readFileSync(`${ROOT}/demos.json`, "utf8"));
const want = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1800, height: 1200 }, args: ["--allow-file-access-from-files"] });
for (const d of data.demos) {
  if (want.length && !want.includes(d.id)) continue;
  const cells = d.steps
    .map(
      (s, i) => `<div class="c"><div class="im"><img src="file:///${ROOT}/${s.img}">${
        s.hot ? `<i style="left:${s.hot.x}%;top:${s.hot.y}%;width:${s.hot.w}%;height:${s.hot.h}%"></i>` : ""
      }</div><p><b>${i + 1}</b> ${s.caption}</p></div>`
    )
    .join("");
  const html = `<style>body{margin:0;background:#222;color:#eee;font:14px system-ui}h1{font-size:18px;margin:8px 12px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:10px}.c{background:#111}.im{position:relative;aspect-ratio:1280/800}.im img{width:100%;height:100%;display:block}.im i{position:absolute;border:3px solid #ffb300;border-radius:8px;box-shadow:0 0 12px #ffb300}p{margin:6px 8px 10px}</style><h1>${d.title}</h1><div class="g">${cells}</div>`;
  writeFileSync(`${OUT}/sheet_${d.id}.html`, html);
  const page = await browser.newPage();
  await page.goto(`file:///${OUT}/sheet_${d.id}.html`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${OUT}/sheet_${d.id}.png`, fullPage: true });
  await page.close();
  console.log("Bogen", d.id, d.steps.length);
}
await browser.close();
