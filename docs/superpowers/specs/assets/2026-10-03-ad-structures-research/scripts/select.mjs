import fs from 'fs';
const ids = `carolina-tallow 520883207416383 1611709743547178
based-supplies 1233142127741238 1659527714730673 1265058305310739 4304909369740001 697622765983389 1284263500516876 1671647997357037
ancestral-cosmetics 839428982013888 845560184737753 955591563601456 922509710533018 3084283465236879 1430353221912587 1303931671557681 943273368717152 1692555065217500
cottage-design 906818621783491
beauty-from-bees 1442034064205051 1213117624346091 3017476498439219
wild-gold-tallow 925993013445887 934075492468934 1738901370425464 1175091274546616 999798229569441
sarah-miller-kp 1952835781935228 1631438454830419
susan-mitchell 1248534827485196
tallowed-truth 1539268501321139 2233596174076691 1024841400286129 2593136584415760 1300686272185895 1538363817950445 1738020300700067
tallowed-truth-founder 1681276363190077 1860560754871448
penrose 1055366076882894 1888571325173354
pure-good 2072578700061284 1037123369025933
tallow-twins 1599590741566091 2172610590265039
necessaire 1446993407287431
kopari 3408226082716397
osea 1594469975460254
palmers 1471785441450025
eucerin 1120965360585877
primally-pure 1618438473658216`.split('\n').flatMap(l => { const [b, ...r] = l.split(' '); return r.map(id => [b, id]); });
const cand = JSON.parse(fs.readFileSync('candidates.json'));
const byId = new Map(cand.map(a => [a.id, a]));
const sel = [];
const counters = {};
for (const [b, id] of ids) {
  const a = byId.get(id); if (!a) { console.log('MISSING', b, id); continue; }
  const date = new Date(a.start * 1000).toISOString().slice(0, 10);
  const k = b + date; counters[k] = (counters[k] || 0) + 1;
  const shot = `screenshots/${b}-${date}-${counters[k]}.png`;
  sel.push({ brand: b, id, page_id: a.page_id, page_name: a.page_name, pageUrl: a.page_url, adLibraryUrl: `https://www.facebook.com/ads/library/?id=${id}`,
    startDate: date, daysRunning: a.days, primaryText: a.body, headline: a.title, linkDescription: a.link_description, cta: a.cta, linkUrl: a.link_url,
    displayFormat: a.display_format, versions: a.collation_count, imageUrl: a.images[0], imageCount: a.images.length, screenshot: shot });
}
fs.writeFileSync('selected.json', JSON.stringify(sel, null, 1));
console.log(sel.length);
for (const s of sel) {
  const r = await fetch(s.imageUrl); if (!r.ok) { console.log('FAIL', s.id, r.status); continue; }
  const tmp = s.screenshot.replace('.png', '.jpg'); fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
}
