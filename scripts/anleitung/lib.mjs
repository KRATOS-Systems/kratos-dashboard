// Aufnahmehelfer für die Klick-Demos: findet Elemente nach Text, speichert vor jedem Klick ein Bild und die markierte Stelle.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sleep } from "./env.mjs";

const W = 1280;
const H = 800;
const CLICKABLE = "button, a, [role=button], summary, label, .card, input";

export class Rec {
  constructor(page, outRoot, demo) {
    this.page = page;
    this.demo = demo;
    this.dir = path.join(outRoot, demo.id);
    mkdirSync(this.dir, { recursive: true });
    this.steps = [];
  }

  // Sichtbares Element mit diesem Text (kleinstes Element, dessen Text passt); markiert wird der anklickbare Vorfahre
  async find(text, { nth = 0, starts = false, scope = null } = {}) {
    return this.page.evaluate(
      ({ text, nth, starts, scope, CLICKABLE }) => {
        const root = scope ? document.querySelector(scope) : document;
        if (!root) return null;
        const norm = (s) => s.replace(/\s+/g, " ").trim();
        const hits = [...root.querySelectorAll("*")].filter((e) => {
          const t = norm(e.textContent || "");
          if (!(starts ? t.startsWith(text) : t === text)) return false;
          const r = e.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          if (getComputedStyle(e).visibility === "hidden") return false;
          return ![...e.children].some((c) => {
            const ct = norm(c.textContent || "");
            return starts ? ct.startsWith(text) : ct === text;
          });
        });
        const el = hits[nth];
        if (!el) return null;
        const anc = el.closest(CLICKABLE) || el;
        anc.scrollIntoView({ block: "center", inline: "nearest" });
        const r = anc.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      },
      { text, nth, starts, scope, CLICKABLE }
    );
  }

  async findSel(selector, nth = 0) {
    return this.page.evaluate(
      ({ selector, nth }) => {
        const el = [...document.querySelectorAll(selector)].filter((e) => e.getBoundingClientRect().width > 1)[nth];
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      },
      { selector, nth }
    );
  }

  async click(box) {
    await this.page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  }

  // Ein Schritt: Bild aufnehmen (vor dem Klick), Stelle markieren, dann klicken
  async step(caption, target, opts = {}) {
    let box = null;
    const look = async () => (typeof target === "string" ? this.find(target, opts) : target.sel ? this.findSel(target.sel, target.nth || 0) : target);
    if (target) {
      const until = Date.now() + (opts.timeout ?? 12000);
      while (!(box = await look()) && Date.now() < until) await sleep(300);
      if (!box) throw new Error(`Nicht gefunden (${this.demo.id}): ${typeof target === "string" ? target : JSON.stringify(target)}`);
      await sleep(400); // Einblendungen abwarten
      box = (await look()) || box;
    }
    const n = String(this.steps.length + 1).padStart(2, "0");
    const file = `${n}.webp`;
    await this.page.screenshot({ path: path.join(this.dir, file), type: "webp", quality: 80 });
    const pad = 5;
    this.steps.push({
      img: `${this.demo.id}/${file}`,
      caption,
      hot: box ? { x: ((box.x - pad) / W) * 100, y: ((box.y - pad) / H) * 100, w: ((box.w + pad * 2) / W) * 100, h: ((box.h + pad * 2) / H) * 100 } : null,
    });
    if (box && opts.click !== false) {
      await this.click(box);
      await sleep(opts.wait ?? 800);
    }
  }

  async type(selector, text, nth = 0) {
    const box = await this.findSel(selector, nth);
    if (!box) throw new Error(`Eingabefeld nicht gefunden: ${selector}`);
    await this.click(box);
    await this.page.keyboard.down("Control");
    await this.page.keyboard.press("KeyA");
    await this.page.keyboard.up("Control");
    await this.page.keyboard.type(text, { delay: 40 });
    await sleep(200);
  }

  async login(name, pin) {
    const who = await this.find(name);
    await this.click(who);
    await sleep(600);
    for (const d of pin) {
      const b = await this.page.evaluate((d) => {
        const el = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === d && x.getBoundingClientRect().width > 1);
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }, d);
      await this.click(b);
      await sleep(120);
    }
  }

  finish() {
    return { id: this.demo.id, title: this.demo.title, text: this.demo.text, steps: this.steps };
  }
}

export function saveIndex(outRoot, demos) {
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, "demos.json"), JSON.stringify({ demos }, null, 1));
}
