import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emailMessage,
  buildTemplateIndex,
  referencedTemplateIds,
  driftFindings,
  pushVerdict,
  findOrphans,
  strandedIds,
  resolveTarget,
} from '../../lib/flow-template-push.js';

const POSTAL = '1234 Example St, Austin, TX 78701';

const sendEmail = (id, templateId, messageId = 'MSG' + id) => ({
  id,
  attributes: { definition: { type: 'send-email', data: { message: { id: messageId, name: 'n', template_id: templateId } } } },
});
const delay = (id) => ({ id, attributes: { definition: { type: 'time-delay', data: { unit: 'hours', value: 4 } } } });

test('emailMessage reads only send-email actions', () => {
  assert.equal(emailMessage(delay('1')), null);
  assert.equal(emailMessage(sendEmail('2', 'TPL')).template_id, 'TPL');
});

test('emailMessage ignores a send-email with no message id', () => {
  const bare = { id: '3', attributes: { definition: { type: 'send-email', data: {} } } };
  assert.equal(emailMessage(bare), null);
});

test('buildTemplateIndex maps a template to the flow that uses it', () => {
  const flows = [
    { flow: { id: 'F1', name: 'Welcome', status: 'live' }, actions: [delay('1'), sendEmail('2', 'TA5Wi4')] },
  ];
  const idx = buildTemplateIndex(flows);
  assert.deepEqual(idx.get('TA5Wi4'), [
    { flowId: 'F1', flowName: 'Welcome', flowStatus: 'live', actionId: '2', messageId: 'MSG2', messageName: 'n' },
  ]);
});

test('a template shared by two flows records BOTH uses rather than collapsing them', () => {
  // Repointing one flow would silently change the other. The caller must be able to see it.
  const flows = [
    { flow: { id: 'F1', name: 'A', status: 'live' }, actions: [sendEmail('2', 'SHARED')] },
    { flow: { id: 'F2', name: 'B', status: 'live' }, actions: [sendEmail('3', 'SHARED')] },
  ];
  assert.equal(buildTemplateIndex(flows).get('SHARED').length, 2);
});

test('referencedTemplateIds unions flow template_ids with rendered snapshot ids', () => {
  const flows = [{ flow: { id: 'F1', name: 'A', status: 'live' }, actions: [sendEmail('2', 'LIB')] }];
  const ids = referencedTemplateIds(flows, ['SNAP', null]);
  assert.ok(ids.has('LIB') && ids.has('SNAP'));
  assert.ok(!ids.has(null));
});

test('drift is judged on tags and links, not bytes — Klaviyo rewrites markup on save', () => {
  const before = '<style>/* note */ .a{color:#FFF}</style><a href="https://x.com/p">{% coupon_code %}</a>';
  const saved = '<html><head></head><style>\n.a {\n  color: #FFF;\n}\n</style><a href="https://x.com/p">{% coupon_code %}</a></html>';
  assert.deepEqual(driftFindings(before, saved).problems, []);
});

test('drift IS reported when a link or tag actually changed in the UI', () => {
  const before = '<a href="https://x.com/a">{% coupon_code %}</a>';
  const live = '<a href="https://x.com/b">{% coupon_code %}</a>';
  const { problems } = driftFindings(before, live);
  assert.equal(problems.length, 2, 'one lost link and one new link');
  assert.ok(problems.every((p) => p.includes('drifted')));
});

test('a missing .before.html warns but does not block', () => {
  const { problems, warnings } = driftFindings(null, '<p>x</p>');
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, 1);
});

test('pushVerdict passes when tags, links and postal all survive the round trip', () => {
  const intended = `<a href="{% unsubscribe_link %}">out</a><a href="https://x.com/p">{% coupon_code %}</a><p>${POSTAL}</p>`;
  const live = `<html><head></head><body><a href="{% unsubscribe_link %}">out</a>\n<a href="https://x.com/p">{% coupon_code %}</a><p>${POSTAL}</p></body></html>`;
  assert.deepEqual(pushVerdict({ intendedHtml: intended, liveHtml: live, postalAddress: POSTAL }), { ok: true, problems: [] });
});

test('pushVerdict fails on a dropped Klaviyo tag — a lost {% coupon_code %} ships a broken offer', () => {
  const intended = `<a href="{% unsubscribe_link %}">o</a>{% coupon_code %}<p>${POSTAL}</p>`;
  const live = `<a href="{% unsubscribe_link %}">o</a><p>${POSTAL}</p>`;
  const { ok, problems } = pushVerdict({ intendedHtml: intended, liveHtml: live, postalAddress: POSTAL });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('{% coupon_code %}')));
});

test('pushVerdict names a lost compliance link as compliance, not as an ordinary link', () => {
  const intended = `<a href="https://x.com/policies/privacy">p</a><a href="{% unsubscribe_link %}">o</a><p>${POSTAL}</p>`;
  const live = `<a href="{% unsubscribe_link %}">o</a><p>${POSTAL}</p>`;
  const { problems } = pushVerdict({ intendedHtml: intended, liveHtml: live, postalAddress: POSTAL });
  assert.ok(problems.some((p) => p.startsWith('COMPLIANCE link')));
});

test('pushVerdict fails a push that landed the broken {% unsubscribe %} spelling', () => {
  const intended = `<a href="{% unsubscribe %}">o</a><p>${POSTAL}</p>`;
  const live = `<a href="{% unsubscribe %}">o</a><p>${POSTAL}</p>`;
  const { ok, problems } = pushVerdict({ intendedHtml: intended, liveHtml: live, postalAddress: POSTAL });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('unsubscribe_link')));
});

test('pushVerdict fails when the postal address did not survive — CAN-SPAM', () => {
  const intended = `<a href="{% unsubscribe_link %}">o</a><p>${POSTAL}</p>`;
  const live = '<a href="{% unsubscribe_link %}">o</a>';
  const { ok, problems } = pushVerdict({ intendedHtml: intended, liveHtml: live, postalAddress: POSTAL });
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('postal')));
});

test('pushVerdict treats an empty live body as a failed push, not an empty pass', () => {
  const intended = `{% coupon_code %}<p>${POSTAL}</p>`;
  assert.equal(pushVerdict({ intendedHtml: intended, liveHtml: null, postalAddress: POSTAL }).ok, false);
});

test('resolveTarget falls back to the template id for a file never pushed', () => {
  const index = buildTemplateIndex([{ flow: { id: 'F1', name: 'A', status: 'live' }, actions: [sendEmail('2', 'TA5Wi4')] }]);
  const { use, via } = resolveTarget('TA5Wi4', index, {});
  assert.equal(via, 'template id');
  assert.equal(use.actionId, '2');
});

test('resolveTarget still finds the email after a push changed its template id', () => {
  // The whole point: the file is still named TA5Wi4, but the flow now points at ThdZ8y.
  const index = buildTemplateIndex([{ flow: { id: 'F1', name: 'A', status: 'live' }, actions: [sendEmail('2', 'ThdZ8y', 'MSGSTABLE')] }]);
  assert.equal(resolveTarget('TA5Wi4', index, {}).use, null, 'template id alone can no longer find it');
  const { use, via } = resolveTarget('TA5Wi4', index, { TA5Wi4: { messageId: 'MSGSTABLE' } });
  assert.equal(via, 'message id');
  assert.equal(use.actionId, '2');
});

test('resolveTarget reports a remembered message that has vanished rather than silently falling back', () => {
  const index = buildTemplateIndex([{ flow: { id: 'F1', name: 'A', status: 'live' }, actions: [sendEmail('2', 'TA5Wi4')] }]);
  const r = resolveTarget('TA5Wi4', index, { TA5Wi4: { messageId: 'GONE' } });
  assert.equal(r.use, null);
  assert.equal(r.missing, 'GONE');
});

test('resolveTarget refuses a template shared by two flows', () => {
  const index = buildTemplateIndex([
    { flow: { id: 'F1', name: 'A', status: 'live' }, actions: [sendEmail('2', 'SHARED')] },
    { flow: { id: 'F2', name: 'B', status: 'live' }, actions: [sendEmail('3', 'SHARED')] },
  ]);
  const r = resolveTarget('SHARED', index, {});
  assert.equal(r.use, null);
  assert.equal(r.ambiguous.length, 2);
});

test('findOrphans sweeps a template this tool stranded', () => {
  const templates = [{ id: 'A' }, { id: 'B' }];
  const { orphans, kept } = findOrphans({
    templates,
    sweepableIds: new Set(['B']),
    referencedIds: new Set(['A']),
  });
  assert.deepEqual(orphans.map((t) => t.id), ['B']);
  assert.equal(kept[0].reason, 'not stranded by this tool');
});

test('findOrphans NEVER sweeps a template it did not strand, however unreferenced', () => {
  // The real account carries campaign snapshots and named library sources that no FLOW
  // references. An earlier version swept by "unreferenced" and proposed deleting 24 of
  // them, including live campaign content.
  const templates = [
    { id: 'camp_654cb1a2', name: 'camp_654cb1a2' },
    { id: 'SNKGEf', name: 'Post-Purchase — 01 Thank You' },
  ];
  const { orphans, kept } = findOrphans({
    templates,
    sweepableIds: new Set(),
    referencedIds: new Set(),
  });
  assert.deepEqual(orphans, [], 'nothing outside the allowlist may be swept');
  assert.ok(kept.every((k) => k.reason === 'not stranded by this tool'));
});

test('findOrphans spares a stranded id a flow has since picked up again', () => {
  const templates = [{ id: 'reused' }];
  const { orphans, kept } = findOrphans({
    templates,
    sweepableIds: new Set(['reused']),
    referencedIds: new Set(['reused']),
  });
  assert.deepEqual(orphans, []);
  assert.equal(kept[0].reason, 'in use by a flow');
});

test('findOrphans spares a template touched more recently than the cutoff', () => {
  const templates = [
    { id: 'old', updated: '2026-01-01T00:00:00+00:00' },
    { id: 'fresh', updated: '2026-08-30T00:00:00+00:00' },
  ];
  const { orphans, kept } = findOrphans({
    templates,
    sweepableIds: new Set(['old', 'fresh']),
    referencedIds: new Set(),
    olderThan: new Date('2026-08-01T00:00:00Z'),
  });
  assert.deepEqual(orphans.map((t) => t.id), ['old']);
  assert.equal(kept.find((t) => t.id === 'fresh').reason, 'too recent to be certain');
});

test('strandedIds collects every replaced template across the map', () => {
  const map = {
    TA5Wi4: { stranded: ['TA5Wi4'] },
    Ra3L8A: { stranded: ['Ra3L8A', 'XtF4DY'] },
    SHb8Df: {},
  };
  assert.deepEqual([...strandedIds(map)].sort(), ['Ra3L8A', 'TA5Wi4', 'XtF4DY']);
  assert.deepEqual([...strandedIds()], []);
});
