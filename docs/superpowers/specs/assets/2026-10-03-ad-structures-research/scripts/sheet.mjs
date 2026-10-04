import { createRequire } from 'module'; import fs from 'fs'; import path from 'path';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
const sel = JSON.parse(fs.readFileSync('selected.json'));
const b = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const p = await b.newPage(); await p.setViewport({ width: 1500, height: 1100 });
fs.mkdirSync('sheets', { recursive: true });
for (let i = 0; i < sel.length; i += 6) {
  const cells = sel.slice(i, i + 6).map((s, j) => `<div><b>#${i + j} ${s.brand} ${s.daysRunning}d</b><br><img src="data:image/png;base64,${fs.readFileSync(s.screenshot).toString("base64")}"></div>`).join('');
  await p.setContent(`<style>body{margin:0;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font:16px sans-serif}img{width:490px;height:500px;object-fit:contain;background:#eee}</style>${cells}`);
  await new Promise(r => setTimeout(r, 800));
  await p.screenshot({ path: `sheets/s${i / 6}.png` });
}
await b.close();
