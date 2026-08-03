import { readFileSync } from 'node:fs';
import { getAccessToken } from './lib/shopify.js';
const env=Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const token=await getAccessToken();
const gql=async(q,v)=>{const r=await fetch(`https://${env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query:q,variables:v})});const j=await r.json();if(j.errors)console.log('   GQL ERRORS:',JSON.stringify(j.errors).slice(0,300));return j.data;};

// Which products carry a selling plan group at all?
const prods=(await gql(`{ products(first:250){nodes{ handle status
  sellingPlanGroups(first:10){nodes{ id name appId }} }} }`)).products.nodes;
const withPlans=prods.filter(p=>p.sellingPlanGroups.nodes.length);
console.log(`products with a selling plan group: ${withPlans.length} of ${prods.length}\n`);
const byGroup=new Map();
for(const p of withPlans) for(const g of p.sellingPlanGroups.nodes){
  if(!byGroup.has(g.id)) byGroup.set(g.id,{name:g.name,appId:g.appId,products:[]});
  byGroup.get(g.id).products.push(`${p.handle}${p.status==='DRAFT'?' (draft)':''}`);
}
for(const [id,g] of byGroup){
  console.log(`"${g.name}"  appId=${g.appId ?? 'NULL'}  id=${id.split('/').pop()}`);
  console.log(`   ${g.products.length} products: ${g.products.join(', ')}\n`);
}
// Fetch one group directly for its plans
const [firstId]=byGroup.keys();
if(firstId){
  const d=await gql(`{ sellingPlanGroup(id:"${firstId}"){ name merchantCode appId
    sellingPlans(first:20){nodes{ name
      billingPolicy{ ... on SellingPlanRecurringBillingPolicy{ interval intervalCount } }
      deliveryPolicy{ ... on SellingPlanRecurringDeliveryPolicy{ interval intervalCount } }
      pricingPolicies{ ... on SellingPlanFixedPricingPolicy{ adjustmentType } } }} } }`);
  const g=d?.sellingPlanGroup;
  console.log(`--- plans inside "${g?.name}" (merchantCode=${g?.merchantCode}) ---`);
  for(const sp of g?.sellingPlans?.nodes ?? []){
    console.log(`   ${sp.name}: bill ${sp.billingPolicy? sp.billingPolicy.intervalCount+' '+sp.billingPolicy.interval : 'NONE'} | deliver ${sp.deliveryPolicy? sp.deliveryPolicy.intervalCount+' '+sp.deliveryPolicy.interval : 'NONE'} | ${sp.pricingPolicies?.[0]?.adjustmentType ?? 'no discount'}`);
  }
}
