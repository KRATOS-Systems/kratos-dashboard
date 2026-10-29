// Startet Test-Odoo und App (Testdatenbank) und gibt einen Browser zurück. Nur Testdaten, nie die echte Instanz.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

export const PROJECT = "C:/Users/Alexander.Meimeteas/Desktop/Claude/Claude Code/Web App/kratos-dashboard";
const ODOO_PORT = 8091;
export const APP_PORT = 3091;
export const APP = `http://localhost:${APP_PORT}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "anleitung-"));
  const env = {
    ...process.env,
    MOCK_PORT: String(ODOO_PORT),
    PORT: String(APP_PORT),
    DB_PATH: path.join(dir, "demo.db"),
    BDE_ODOO_URL: `http://localhost:${ODOO_PORT}`,
    BDE_ODOO_API_KEY: "test",
    BDE_WRITE: "1",
    BDE_SECRET: "demogeheimnis",
    ODOO_URL: "",
    ODOO_API_KEY: "",
  };
  const procs = [spawn("node", ["scripts/mockOdoo.mjs"], { env, cwd: PROJECT, stdio: "ignore" }), spawn("node", ["server/index.js"], { env, cwd: PROJECT, stdio: "ignore" })];
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${APP}/api/bde/session`);
      await fetch(`http://localhost:${ODOO_PORT}/__log`);
      break;
    } catch {
      await sleep(250);
    }
  }
  const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, args: ["--no-sandbox", "--hide-scrollbars"] });
  const stop = async () => {
    await browser.close().catch(() => {});
    procs.forEach((p) => p.kill());
    await sleep(800);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Temp darf liegen bleiben */
    }
  };
  const mock = (model, method, body) =>
    fetch(`http://localhost:${ODOO_PORT}/json/2/${model}/${method}`, { method: "POST", headers: { Authorization: "bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  return { browser, stop, mock };
}
