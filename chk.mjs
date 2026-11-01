import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git',['diff','--name-only'],{encoding:'utf8'}).trim().split('\n').filter(f=>f.includes('.claude/skills'));
const d=s=>(s.match(/^description: (.*)$/m)||[,''])[1];
const cl=s=>s.split(/,\s+(?=[a-z])/).map(x=>x.trim()).filter(Boolean);
const n=x=>x.toLowerCase().replace(/[^a-z0-9 ]/g,'').slice(0,45);
const hb=s=>s.split('\n').filter(l=>l.startsWith('## ')).map(l=>l.slice(3).trim());
for(const f of files){
  const before=execFileSync('git',['show',`HEAD:${f}`],{encoding:'utf8'});
  const after=readFileSync(f,'utf8');
  const as=new Set(cl(d(after)).map(n));
  const dropped=cl(d(before)).filter(c=>!as.has(n(c)));
  const bh=hb(before), ah=new Set(hb(after));
  const lost=bh.filter(h=>!ah.has(h));
  const name=f.split('/')[2];
  console.log(`${name}\n  desc ${d(before).length}->${d(after).length}  dropped-clauses: ${dropped.length?dropped.join(' | '):'none'}`);
  console.log(`  sections ${bh.length}->${hb(after).length}  removed: ${lost.length?lost.map(x=>x.slice(0,60)).join(' | '):'none'}`);
}
