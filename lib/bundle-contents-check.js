/**
 * Compare the unit counts asserted in a bundle's customer-facing `bundle.contents` copy
 * against the quantities Shopify actually fulfils.
 *
 * verify-bundle-contents already checks two things: that every component's variant title
 * appears in the copy, and that the copy promises no variant that isn't a component.
 * Neither looks at quantity. The 90-Day Coconut Reset shipped **3** creams while its copy
 * said **1**, and passed both checks — the variant title was there and nothing phantom was
 * promised. The page understated the box by two units for as long as it was live.
 *
 * Digital goods are excluded: they are real line items in the value stack but are not
 * Shopify components, so counting them would make correct copy fail.
 */

const LINE = /^\s*(\d+)\s*[×x]\s*(.+)$/gim;
const DIGITAL = /digital|guide|pdf|ebook|download/i;

/**
 * @param copy       the bundle.contents prose
 * @param components [{ quantity, productVariant: { title, product: { title } } }]
 * @returns string[] — one problem per mismatch, empty when consistent or uncheckable
 */
export function quantityFindings(copy, components) {
  const lines = [...String(copy ?? '').matchAll(LINE)]
    .map((m) => ({ qty: Number(m[1]), label: m[2].trim() }))
    .filter((l) => !DIGITAL.test(l.label));

  // No quantity markers means there is nothing to compare. The title and phantom checks
  // still apply, so inventing a failure here would be noise.
  if (!lines.length) return [];

  const said = lines.reduce((s, l) => s + l.qty, 0);
  const ships = components.reduce((s, c) => s + c.quantity, 0);
  if (said === ships) return [];

  return [
    `contents copy says ${said} physical unit(s) but the bundle ships ${ships} — `
    + `copy lists ${lines.map((l) => `${l.qty}× ${l.label.split('—')[0].trim()}`).join(', ')}`,
  ];
}
