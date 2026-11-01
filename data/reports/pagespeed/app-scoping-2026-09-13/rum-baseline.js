const fs=require("fs");const dir="data/snapshots/rum";const CUT=Date.parse("2026-09-13T23:06:46Z");
const files=fs.readdirSync(dir).filter(f=>f>="2026-08-30"&&f.endsWith(".jsonl"));
const buckets={};
const p75=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.ceil(0.75*s.length)-1)];};
for(const f of files){for(const line of fs.readFileSync(dir+"/"+f,"utf8").split("\n")){if(!line)continue;let b;try{b=JSON.parse(line)}catch{continue}
 const era=Date.parse(b.ts)<CUT?"9.2.0":"9.4.0";const dev=b.device==="mobile"?"mobile":"desktop+tablet";
 for(const key of [`${era}|${dev}|ALL`,`${era}|${dev}|${b.template||"?"}`]){const k=(buckets[key]??={n:0,LCP:[],INP:[],CLS:[],FCP:[],TTFB:[]});k.n++;for(const m of b.metrics||[])if(k[m.name])k[m.name].push(m.value);}}}
const rows=Object.entries(buckets).sort().map(([k,v])=>`${k.padEnd(40)} beacons ${String(v.n).padStart(5)}  LCP p75 ${p75(v.LCP)} (n${v.LCP.length})  INP p75 ${p75(v.INP)} (n${v.INP.length})  CLS p75 ${p75(v.CLS)?.toFixed?.(3)} (n${v.CLS.length})  FCP p75 ${p75(v.FCP)}`);
console.log("files",files[0],"→",files.at(-1));console.log(rows.join("\n"));
