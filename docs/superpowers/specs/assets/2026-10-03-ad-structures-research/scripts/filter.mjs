import fs from 'fs';
const files = fs.readdirSync('raw').filter(f => !f.startsWith('kw'));
const REF = Date.UTC(2026, 9, 3) / 1000;
const REL = /lotion|cream|butter|balm|tallow|skin ?food|moisturi[sz]|body (oil|care|glow)|dry skin|crepey|hydrat/i;
const EXCL = /\bspf\b|sunscreen|deodorant|serum|cleanser|face wash|shampoo|perfume|eau de|fragrance mist|lip (oil|gloss)/i;
const all = []; const seen = new Set();
for (const f of files) {
  const brand = f.replace('.json', '').replace(/^old-/, '');
  for (const a of JSON.parse(fs.readFileSync('raw/' + f))) {
    if (seen.has(a.id) || a.videos || !a.images.length) continue; seen.add(a.id);
    if (a.display_format === 'DPA') continue;
    const txt = [a.body, a.title, a.link_description, a.link_url].join(' ');
    if (/\{\{product/.test(txt)) continue;
    a.brand = brand; a.days = Math.floor((REF - a.start) / 86400);
    a.rel = REL.test(txt); a.excl = EXCL.test(txt);
    all.push(a);
  }
}
all.sort((x, y) => y.days - x.days);
fs.writeFileSync('candidates.json', JSON.stringify(all, null, 1));
const byBrand = {}; all.forEach(a => { byBrand[a.brand] = byBrand[a.brand] || []; byBrand[a.brand].push(a); });
for (const [b, l] of Object.entries(byBrand)) {
  console.log(`\n## ${b}: ${l.length} static, ${l.filter(a=>a.rel&&!a.excl).length} relevant`);
  for (const a of l.filter(a => a.days >= 60).slice(0, 12)) console.log(a.days, a.display_format, a.rel ? 'R' : '-', a.excl ? 'X' : '-', a.id, '|', (a.title||'').slice(0, 45), '|', a.body.slice(0, 90).replace(/\n/g, ' '));
}
