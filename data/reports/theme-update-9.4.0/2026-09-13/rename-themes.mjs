import { getThemes, shopifyGraphQL } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
const NEW = 148782940330, OLD = 148439367850;
const t = await getThemes();
if (t.find((x) => x.id === NEW)?.role !== 'main' || t.find((x) => x.id === OLD)?.role !== 'unpublished') throw new Error('ABORT: roles not as expected');
const m = `mutation($id: ID!, $input: OnlineStoreThemeInput!) { themeUpdate(id: $id, input: $input) { theme { id name role } userErrors { field message } } }`;
for (const [id, name] of [[NEW, 'Real Skin Care — Live (Be Yours 9.4.0)'], [OLD, 'Rollback — Be Yours 9.2.0 (unpublished 2026-09-13)']]) {
  console.log(JSON.stringify(await shopifyGraphQL(m, { id: `gid://shopify/OnlineStoreTheme/${id}`, input: { name } })));
}
