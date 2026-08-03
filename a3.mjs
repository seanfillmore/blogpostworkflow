import { readFileSync } from 'node:fs';
import { getAccessToken } from './lib/shopify.js';
import { bindingDuration } from './lib/supply-duration.js';
const env=Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const token=await getAccessToken();
const gql=async q=>{const r=await fetch(`https://${env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)console.log('ERR',JSON.stringify(j.errors).slice(0,200));return j.data;};
const prods=(await gql(`{ products(first:250){nodes{ handle status
  sellingPlanGroups(first:10){nodes{ id name appId }} }} }`)).products.nodes;
const seen=new Set();
console.log('group                       merchantCode        plan / billing / delivery / discount   products');
for(const p of prods) for(const g of p.sellingPlanGroups.nodes){
  if(seen.has(g.id)) continue; seen.add(g.id);
  const d=await gql(`{ sellingPlanGroup(id:"${g.id}"){ name merchantCode
    products(first:10){nodes{handle}}
    sellingPlans(first:10){nodes{ name
      billingPolicy{ ... on SellingPlanRecurringBillingPolicy{ interval intervalCount } }
      deliveryPolicy{ ... on SellingPlanRecurringDeliveryPolicy{ interval intervalCount } }
      pricingPolicies{ ... on SellingPlanFixedPricingPolicy{ adjustmentType adjustmentValue{ ... on SellingPlanPricingPolicyPercentageValue{percentage} } } } }} } }`);
  const G=d.sellingPlanGroup;
  for(const sp of G.sellingPlans.nodes){
    const b=sp.billingPolicy, dl=sp.deliveryPolicy, pr=sp.pricingPolicies?.[0];
    console.log(`${G.name.padEnd(20)} ${String(G.merchantCode).padEnd(20)} ${sp.name.padEnd(22)} ${b?b.intervalCount+' '+b.interval:'—'} / ${dl?dl.intervalCount+' '+dl.interval:'—'} / ${pr?.adjustmentValue?.percentage ?? '?'}%   ${G.products.nodes.map(x=>x.handle).join(', ')}`);
  }
}
console.log('\n=== how long each subscribed product actually lasts (config/consumption-rates.json) ===');
const {bundles}=JSON.parse(readFileSync('config/bundles.json','utf8'));
for(const h of ['coconut-bar-soap-4-pack','coconut-deodorant-4-pack','coconut-toothpaste-3-pack','sensitive-skin-starter-set']){
  const b=bundles.find(x=>x.handle===h);
  if(!b){console.log(`  ${h}: not in roster`);continue;}
  const r=bindingDuration(b.variants[0].components);
  console.log(`  ${h.padEnd(30)} binding ${String(r.days??'?').padStart(4)} d (${r.limitedBy??'no rate'})  → a MONTHLY plan ships ${r.days?(r.days/30).toFixed(1):'?'}× too often`);
}
for(const h of ['coconut-lotion','coconut-moisturizer']){
  const r=bindingDuration([{product:h,qty:1}]);
  console.log(`  ${h.padEnd(30)} binding ${String(r.days??'?').padStart(4)} d  → monthly is ${r.days?(r.days/30).toFixed(2):'?'}×`);
}
