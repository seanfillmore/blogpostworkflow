const fs=require("fs");const dir="data/snapshots/rum";
const files=fs.readdirSync(dir).filter(f=>f>="2026-08-17"&&f.endsWith(".jsonl"));
const p75=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.ceil(.75*s.length)-1];};
const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
const g={};
for(const f of files)for(const line of fs.readFileSync(dir+"/"+f,"utf8").split("\n")){if(!line)continue;let b;try{b=JSON.parse(line)}catch{continue}
 if(b.device==="mobile")continue;const t=b.template;if(!["article","collection","product","index","page"].includes(t))continue;
 const m=(b.metrics||[]).find(x=>x.name==="LCP");if(!m)continue;const a=m.attr||{};
 const k=(g[t]??={n:0,v:[],ttfb:[],ld:[],ldur:[],rd:[],els:{},kinds:{},slow:{n:0,els:{},urls:{},rd:[],ldur:[],ld:[],ttfb:[]}});
 k.n++;k.v.push(m.value);["ttfb","loadDelay","loadDuration","renderDelay"].forEach((f,i)=>{if(typeof a[f]==="number")[k.ttfb,k.ld,k.ldur,k.rd][i].push(a[f]);});
 const el=(a.element||"(none)").replace(/template--\d+__/g,"T__").replace(/-\d{6,}/g,"-N").slice(0,90);
 k.els[el]=(k.els[el]||0)+1;const kind=a.url?"image":"text/no-url";k.kinds[kind]=(k.kinds[kind]||0)+1;
 if(m.value>2500){const s=k.slow;s.n++;s.els[el]=(s.els[el]||0)+1;if(a.url){const u=a.url.replace(/\?.*$/,"").replace(/^https?:\/\/[^/]+/,"").slice(-70);s.urls[u]=(s.urls[u]||0)+1;}
  ["ttfb","loadDelay","loadDuration","renderDelay"].forEach((f,i)=>{if(typeof a[f]==="number")[s.ttfb,s.ld,s.ldur,s.rd][i].push(a[f]);});}
}
const top=(o,n)=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,v])=>`${v}× ${k}`).join("\n      ");
for(const [t,k] of Object.entries(g)){console.log(`\n## desktop/tablet ${t}: n=${k.n} LCP p75 ${p75(k.v)} | kinds ${JSON.stringify(k.kinds)}`);
 console.log(`  subparts median: ttfb ${med(k.ttfb)} loadDelay ${med(k.ld)} loadDuration ${med(k.ldur)} renderDelay ${med(k.rd)}`);
 console.log(`  top LCP elements:\n      ${top(k.els,5)}`);
 const s=k.slow;console.log(`  SLOW (>2.5s) n=${s.n}: median ttfb ${med(s.ttfb)} loadDelay ${med(s.ld)} loadDuration ${med(s.ldur)} renderDelay ${med(s.rd)}`);
 console.log(`    slow elements:\n      ${top(s.els,5)}`);console.log(`    slow image urls:\n      ${top(s.urls,5)}`);}
