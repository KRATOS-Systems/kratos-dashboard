// Erzeugt public/look/hoehenlinien.svg: feine Höhenlinien als Hintergrund des neuen Looks (nur Zierde). Start: node scripts/hoehenlinien.mjs
import { writeFileSync } from "node:fs";
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const W = 1800, H = 1200;
const isles = [[420, 280, 250, 12], [1180, 220, 190, 10], [1450, 640, 280, 13], [620, 800, 230, 11], [160, 940, 170, 8], [980, 1020, 150, 8], [60, 420, 120, 6]];
let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">`;
for (const [cx, cy, R, n] of isles) {
  const p1 = rnd() * 6, p2 = rnd() * 6, p3 = rnd() * 6;
  for (let k = 0; k < n; k++) {
    const r = R * (1 - k / (n + 1)), pts = [];
    for (let a = 0; a <= 72; a++) {
      const t = (a / 72) * Math.PI * 2;
      const rr = r * (1 + 0.2 * Math.sin(3 * t + p1) + 0.11 * Math.sin(5 * t + p2) + 0.06 * Math.sin(9 * t + p3 + k * 0.2));
      pts.push(`${(cx + rr * 1.25 * Math.cos(t)).toFixed(1)},${(cy + rr * 0.82 * Math.sin(t)).toFixed(1)}`);
    }
    s += `<polygon points="${pts.join(" ")}" fill="${k === 0 ? "#fff" : "none"}" fill-opacity="${k === 0 ? 0.035 : 0}" stroke="#fff" stroke-opacity="${(0.05 + (k / n) * 0.11).toFixed(3)}" stroke-width="1"/>`;
  }
}
writeFileSync("public/look/hoehenlinien.svg", s + "</svg>");
console.log("ok");
