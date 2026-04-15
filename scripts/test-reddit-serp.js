#!/usr/bin/env node
/**
 * Quick test: pull Reddit threads via DataForSEO SERP API
 * Run: node scripts/test-reddit-serp.js
 */

import 'dotenv/config';
import { getSerpResults } from '../lib/dataforseo.js';

const QUERIES = [
  'site:reddit.com skincare routine beginner',
  'site:reddit.com best moisturizer dry skin',
  'site:reddit.com retinol vs tretinoin',
];

async function main() {
  for (const query of QUERIES) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`QUERY: ${query}`);
    console.log('─'.repeat(60));

    const { organic } = await getSerpResults(query, 10);

    const redditResults = organic.filter((r) => r.domain === 'www.reddit.com' || r.domain === 'reddit.com');

    if (!redditResults.length) {
      console.log('No Reddit results returned.');
      continue;
    }

    for (const r of redditResults) {
      console.log(`\n[#${r.position}] ${r.title}`);
      console.log(`URL: ${r.url}`);
      if (r.description) console.log(`Snippet: ${r.description}`);
    }
  }
}

main().catch(console.error);
