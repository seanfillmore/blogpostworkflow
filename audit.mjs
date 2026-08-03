import { readFileSync } from 'node:fs';
import { getAccessToken } from './lib/shopify.js';
const env=Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const token=await getAccessToken();
const gql=async(q,v)=>{const r=await fetch(`https://${env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query:q,variables:v})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,400));return j.data;};

console.log('=== every selling plan group in the store ===');
let cursor=null;
const groups=[];
for(let i=0;i<10;i++){
  const d=await gql(`query($c:String){ sellingPlanGroups(first:50, after:$c){ pageInfo{hasNextPage endCursor}
    nodes{ id name merchantCode appId createdAt
      productsCount{count} productVariantsCount{count}
      sellingPlans(first:20){nodes{ id name options
        billingPolicy{ ... on SellingPlanRecurringBillingPolicy { interval intervalCount } }
        pricingPolicies{ ... on SellingPlanFixedPricingPolicy { adjustmentType adjustmentValue{ ... on SellingPlanPricingPolicyPercentageValue { percentage } } } } }} } } }`,{c:cursor});
  groups.push(...d.sellingPlanGroups.nodes);
  if(!d.sellingPlanGroups.pageInfo.hasNextPage) break; cursor=d.sellingPlanGroups.pageInfo.endCursor;
}
for(const g of groups){
  console.log(`\n"${g.name}"  merchantCode=${g.merchantCode}`);
  console.log(`   appId: ${g.appId ?? 'NULL  ← created via Admin API, no app owns it'}`);
  console.log(`   created ${g.createdAt?.slice(0,10)}  products=${g.productsCount?.count}  variants=${g.productVariantsCount?.count}`);
  for(const sp of g.sellingPlans.nodes){
    const b=sp.billingPolicy, p=sp.pricingPolicies?.[0];
    console.log(`     plan: ${sp.name} | billing ${b? `every ${b.intervalCount} ${b.interval}` : '(none)'} | ${p? `${p.adjustmentType} ${p.adjustmentValue?.percentage ?? ''}%` : 'no pricing policy'}`);
  }
}
