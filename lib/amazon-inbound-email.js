/**
 * Email copy for the Culina inbound shipment automation.
 *
 * Pure: every function returns { subject, text, html } and does no I/O.
 * Travis-facing copy is written as Sean ("Hi Travis," ... "Sean"); notes to
 * Sean are short operational notes. No em or en dashes in anything we write
 * (a line quoted verbatim from Travis is his own text).
 */

export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const casesWord = (n) => plural(n, 'case');

function build(subject, blocks) {
  // blocks: array of { p: string } | { ul: string[] }
  const text = blocks
    .map((b) => (b.p !== undefined ? b.p : b.ul.map((l) => `- ${l}`).join('\n')))
    .join('\n\n');
  const html = blocks
    .map((b) => (b.p !== undefined
      ? `<p>${esc(b.p).replace(/\n/g, '<br>')}</p>`
      : `<ul>${b.ul.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`))
    .join('\n');
  return { subject, text, html };
}

const pickupText = (mode) =>
  mode === 'FREIGHT_LTL'
    ? 'the carrier will contact you to schedule a pickup'
    : 'Drop the boxes at any UPS location or schedule a UPS pickup';

const modeText = (mode, carrier) =>
  `${mode === 'FREIGHT_LTL' ? 'freight (LTL)' : 'small parcel'}${carrier ? `, ${carrier}` : ''}`;

const casesByPack = (cases) => (cases || []).map((c) => `${casesWord(c.count)} of ${c.key}`).join(', ');

const awdPackList = (lines) =>
  (lines || []).map((l) => `${casesWord(l.cases ?? l.count)} of ${l.key}`).join(', ');

export function labelsReply({ record, shipments, awdLines }) {
  const base = record?.subject ? String(record.subject).replace(/^(re:\s*)+/i, '') : 'shipment';
  const blocks = [
    { p: 'Hi Travis,' },
    { p: shipments.length === 1
      ? 'Your shipment is booked with Amazon. The box labels are attached.'
      : `Your cases are booked with Amazon as ${shipments.length} shipments. The box labels are attached.` },
  ];
  for (const s of shipments) {
    const lines = [
      `Shipment ${s.shipmentId}, to ${s.destination}`,
      `Cases: ${casesByPack(s.cases)}`,
      `Shipping: ${modeText(s.mode, s.carrier)}`,
      `Pickup: ${pickupText(s.mode)}`,
    ];
    if (s.mode === 'FREIGHT_LTL' && Array.isArray(s.pallets) && s.pallets.length) {
      lines.push(`Pallets: ${plural(s.pallets.length, 'pallet')}, 48 x 40 in, no taller than 60 in including the pallet, not stackable`);
      s.pallets.forEach((p, i) => {
        const total = (p.cases || []).reduce((n, c) => n + c.count, 0);
        lines.push(`Pallet ${i + 1} (${casesWord(total)}): ${(p.cases || []).map((c) => `${c.count} x ${c.key || c.sku}`).join(', ')}`);
      });
    }
    blocks.push({ ul: lines });
  }
  if (awdLines && awdLines.length) {
    blocks.push({ p: `The other cases (${awdPackList(awdLines)}) go to Amazon's AWD warehouse. Those labels follow in a separate email.` });
  }
  blocks.push({ p: 'Sean' });
  return build(`Re: ${base}`, blocks);
}

export function awdLabelsReply({ awdShipmentId, lines }) {
  return build(`AWD labels for ${awdShipmentId}`, [
    { p: 'Hi Travis,' },
    { p: `The labels for the AWD cases are attached (AWD shipment ${awdShipmentId}).` },
    { ul: (lines || []).map((l) => `${casesWord(l.cases ?? l.count)} of ${l.key}`) },
    { p: 'Please put one label on each case. The carrier will contact you to schedule the pickup.' },
    { p: 'Sean' },
  ]);
}

export function resendRequest({ problems }) {
  const blocks = [
    { p: 'Hi Travis,' },
    { p: 'I could not read the case list, so nothing is booked yet. These lines did not make sense to me:' },
    { ul: (problems || []).map((p) => `${p.raw}${p.reason ? ` (${p.reason})` : ''}`) },
    { p: 'Could you resend the list with one pack per line, like this?' },
    { p: '2-pack (10 cases - 200 units)' },
    { p: 'Sean' },
  ];
  return build('Please resend the case list', blocks);
}

export function awdHandoff({ lines, shipFrom, reasons }) {
  const blocks = [
    { p: 'Cases are going to AWD. Please create the inbound in Seller Central: Send to Amazon, destination AWD, Amazon partnered carrier.' },
    { p: `Ship from ${shipFrom?.name || 'CMS'}, ${[shipFrom?.addressLine1, shipFrom?.city, shipFrom?.stateOrProvinceCode, shipFrom?.postalCode].filter(Boolean).join(', ')}.` },
    { ul: (lines || []).map((l) => {
      const dims = l.case_in ? `${l.case_in.l} x ${l.case_in.w} x ${l.case_in.h} in` : 'dims unknown';
      const exp = l.expiration ? `, expiration date ${l.expiration}` : '';
      return `${l.key}, SKU ${l.sku}, ASIN ${l.asin}: ${casesWord(l.cases ?? l.count)}, ${l.units_per_case} units/case, case ${dims}, ${l.case_lb} lb${exp}`;
    }) },
  ];
  if ((lines || []).some((l) => l.expiration)) {
    blocks.push({ p: 'Enter the expiration date shown above for that pack in Seller Central, so AWD and FBA carry the same date.' });
  }
  if (reasons && reasons.length) {
    blocks.push({ p: 'Why the split:' });
    blocks.push({ ul: reasons.map(String) });
  }
  return build('Culina: create the AWD inbound', blocks);
}

export function awdReminder({ awdShipmentId, days, lines } = {}) {
  const what = lines && lines.length ? ` (${awdPackList(lines)})` : '';
  return build('Culina: AWD inbound still not created', [
    { p: `The AWD cases${what} were handed off ${days ? `${plural(days, 'day')} ago` : 'a few days ago'} and I do not see an AWD inbound${awdShipmentId ? ` (${awdShipmentId})` : ''} in Amazon yet. Travis is waiting on labels.` },
  ]);
}

export function heldNotice({ reason, text }) {
  const blocks = [{ p: `Held, nothing booked: ${reason}` }];
  if (text) blocks.push({ p: `Travis's email:\n${text}` });
  return build('Culina inbound email held', blocks);
}

export function alreadyPlacedNotice({ covering, lines }) {
  const ids = (covering || []).join(', ');
  const blocks = [
    { p: `Travis's cases already appear on shipments created after his email (${ids}), so I booked nothing.` },
  ];
  if (lines && lines.length) blocks.push({ p: `His list: ${awdPackList(lines)}` });
  return build('Culina inbound already placed', blocks);
}

export function failureNotice({ messageId, step, planId, error }) {
  return build('Culina inbound failed', [{ ul: [
    `Message: ${messageId}`,
    `Step: ${step}`,
    `Plan: ${planId || 'none'}`,
    `Amazon error: ${error}`,
  ] }]);
}
