# Campaign Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Campaign Proposals cards in the Ads tab to match the dashboard's design system, show full proposal data, and add a live budget editor with proportional projection recalculation.

**Architecture:** All changes are in `agents/dashboard/index.js` — CSS, HTML structure, and client-side JS. No new files, no server-side changes, no test file changes. The file is a single-file Node.js server that embeds HTML/CSS/JS as template literals.

**Tech Stack:** Node.js (server), vanilla JS + inline CSS (browser), no build step.

---

## File Map

| File | Change |
|------|--------|
| `agents/dashboard/index.js` lines ~761–774 | Replace old `.camp-proposal*` CSS with new design classes |
| `agents/dashboard/index.js` lines ~907–913 | Update proposals card HTML to use `.card-header` pattern |
| `agents/dashboard/index.js` lines ~2302–2327 | Rewrite proposals section of `renderCampaignCards()` |
| `agents/dashboard/index.js` lines ~2375–2383 | Update `approveCampaign()` to read new input id; add `updateProjections()` |

---

### Task 1: Create branch + replace old CSS with new design classes

**Files:**
- Modify: `agents/dashboard/index.js` lines ~761–774

- [ ] **Step 1: Create branch**

```bash
git checkout -b feature/campaign-card-redesign
```

- [ ] **Step 2: Replace old CSS block**

Find and replace the entire old block (lines ~761–774):

```css
  .camp-proposal { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 10px; }
  .camp-proposal-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
  .camp-proposal-name { font-weight: 600; font-size: 14px; }
  .camp-proposal-meta { font-size: 12px; color: #64748b; margin-top: 3px; }
  .camp-proposal-rationale { font-size: 12px; color: #475569; margin-bottom: 10px; line-height: 1.4; }
  .camp-proposal-actions { display: flex; gap: 8px; }
  .camp-budget-input { width: 70px; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 12px; }
```

Replace with:

```css
  .proposal { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
  .proposal:last-child { margin-bottom: 0; }
  .proposal-head { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; gap: 12px; background: #fafbff; }
  .proposal-name { font-size: 14px; font-weight: 700; color: var(--text); }
  .proposal-sub  { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .proposal-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .metrics-row { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr 1fr; border-bottom: 1px solid var(--border); }
  .metric { padding: 12px 16px; border-right: 1px solid var(--border); }
  .metric:last-child { border-right: none; }
  .metric-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 4px; }
  .metric-value { font-size: 18px; font-weight: 800; color: var(--text); line-height: 1; }
  .metric-unit  { font-size: 11px; color: var(--muted); font-weight: 500; }
  .metric-note  { font-size: 10px; color: var(--muted); margin-top: 3px; }
  .budget-metric { background: #fafbff; }
  .budget-row   { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .budget-input { width: 72px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 15px; font-weight: 800; font-family: inherit; color: var(--text); background: white; }
  .budget-input:focus { outline: none; border-color: var(--indigo); box-shadow: 0 0 0 2px rgba(67,56,202,.12); }
  .update-btn { padding: 4px 10px; font-size: 11px; font-weight: 600; background: var(--indigo); color: white; border: none; border-radius: 5px; cursor: pointer; font-family: inherit; display: none; }
  .update-btn.visible { display: block; }
  .rationale-row  { padding: 13px 16px; border-bottom: 1px solid var(--border); }
  .rationale-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-bottom: 5px; }
  .rationale-text  { font-size: 12px; color: #374151; line-height: 1.6; }
  .adgroups-row    { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .adgroups-label  { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-right: 4px; flex-shrink: 0; }
  .adgroup-pill    { background: #f1f5f9; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; color: var(--text); }
  .adgroup-kw      { font-size: 10px; color: var(--muted); font-weight: 400; }
  .proposal-actions { padding: 12px 16px; display: flex; gap: 8px; align-items: center; }
  .proposal-action-note { font-size: 11px; color: var(--muted); margin-left: auto; }
  .btn-approve  { padding: 7px 16px; font-size: 12px; font-weight: 600; border-radius: 6px; border: none; cursor: pointer; font-family: inherit; background: var(--green); color: white; }
  .btn-approve:hover { background: #15803d; }
  .btn-launch   { padding: 7px 16px; font-size: 12px; font-weight: 600; border-radius: 6px; border: none; cursor: pointer; font-family: inherit; background: var(--indigo); color: white; }
  .btn-launch:hover { background: #3730a3; }
  .btn-dismiss  { padding: 7px 16px; font-size: 12px; font-weight: 600; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; font-family: inherit; background: none; color: var(--muted); }
  .btn-dismiss:hover { color: var(--red); border-color: var(--red); }
```

- [ ] **Step 3: Verify the server still starts**

```bash
node agents/dashboard/index.js &
sleep 1 && curl -s -u "sean:$(grep DASHBOARD_PASSWORD .env | cut -d= -f2)" http://localhost:4242/ | grep -c "proposal" && kill %1
```

Expected: a number ≥ 1 (CSS class names appear in source)

---

### Task 2: Update Campaign Proposals card HTML to use `.card-header` pattern

**Files:**
- Modify: `agents/dashboard/index.js` lines ~907–913

The existing proposals card uses non-standard `section-header`/`section-title` divs instead of the standard `.card-header` pattern. Fix this while also adding padding wrapper for the proposal items.

- [ ] **Step 1: Replace card HTML**

Find:
```html
  <div class="card" id="campaign-proposals-card" style="display:none">
    <div class="section-header">
      <div class="section-title">Campaign Proposals</div>
      <div class="section-note" id="campaign-proposals-note"></div>
    </div>
    <div id="campaign-proposals-body"></div>
  </div>
```

Replace with:
```html
  <div class="card" id="campaign-proposals-card" style="display:none">
    <div class="card-header accent-indigo">
      <h2>Campaign Proposals</h2>
      <span style="font-size:11px;color:var(--muted)" id="campaign-proposals-note"></span>
    </div>
    <div style="padding:16px" id="campaign-proposals-body"></div>
  </div>
```

- [ ] **Step 2: Verify page still loads**

```bash
node agents/dashboard/index.js &
sleep 1 && curl -s -u "sean:$(grep DASHBOARD_PASSWORD .env | cut -d= -f2)" http://localhost:4242/ | grep -c "campaign-proposals-card" && kill %1
```

Expected: `1`

---

### Task 3: Rewrite the proposals renderer in `renderCampaignCards()`

**Files:**
- Modify: `agents/dashboard/index.js` lines ~2302–2327

This is the core of the redesign. Replace the proposals section of `renderCampaignCards()` with the new 5-section layout.

- [ ] **Step 1: Replace the proposals section**

Find this entire block (the proposals section inside `renderCampaignCards`):
```js
  // --- Proposals ---
  const proposals = campaigns.filter(c => (c.status === 'proposed' || c.status === 'approved') && !c.clarificationNeeded);
  const propCard = document.getElementById('campaign-proposals-card');
  const propBody = document.getElementById('campaign-proposals-body');
  if (proposals.length > 0) {
    propCard.style.display = '';
    document.getElementById('campaign-proposals-note').textContent = proposals.length + ' pending';
    propBody.innerHTML = proposals.map(c => {
      const p = c.proposal;
      return '<div class="camp-proposal" id="prop-' + esc(c.id) + '">' +
        '<div class="camp-proposal-header">' +
        '<div><div class="camp-proposal-name">' + esc(p.campaignName) + '</div>' +
        '<div class="camp-proposal-meta">Budget: $<input class="camp-budget-input" id="budget-' + esc(c.id) + '" type="number" min="1" step="0.5" value="' + (p.suggestedBudget || 5) + '">/day &nbsp;|&nbsp; ' +
        'Proj: $' + (c.projections?.monthlyRevenue || '—') + '/mo · ' + (c.projections?.monthlyConversions || '—') + ' conv</div></div>' +
        '<span class="badge badge-gray">' + esc(c.status) + '</span></div>' +
        '<div class="camp-proposal-rationale">' + esc((c.rationale || '').slice(0, 120)) + (c.rationale?.length > 120 ? '…' : '') + '</div>' +
        '<div class="camp-proposal-actions">' +
        '<button onclick="approveCampaign(&apos;' + esc(c.id) + '&apos;)" id="approve-btn-' + esc(c.id) + '">Approve</button>' +
        '<button onclick="dismissCampaign(&apos;' + esc(c.id) + '&apos;)" class="btn-secondary">Dismiss</button>' +
        '</div>' +
        '<div id="launch-row-' + esc(c.id) + '" style="display:none;margin-top:8px">' +
        '<button onclick="launchCampaign(&apos;' + esc(c.id) + '&apos;)" style="background:#10b981">Confirm &amp; Launch</button>' +
        '</div></div>';
    }).join('');
  } else { propCard.style.display = 'none'; }
```

Replace with:
```js
  // --- Proposals ---
  const proposals = campaigns.filter(c => (c.status === 'proposed' || c.status === 'approved') && !c.clarificationNeeded);
  const propCard = document.getElementById('campaign-proposals-card');
  const propBody = document.getElementById('campaign-proposals-body');
  if (proposals.length > 0) {
    propCard.style.display = '';
    document.getElementById('campaign-proposals-note').textContent = proposals.length + ' pending';
    propBody.innerHTML = proposals.map(c => {
      const p = c.proposal;
      const proj = c.projections || {};
      const isApproved = c.status === 'approved';
      const sugBudget = p.suggestedBudget || 5;
      const approvedBudget = p.approvedBudget || sugBudget;
      const displayBudget = isApproved ? approvedBudget : sugBudget;
      const aov = proj.monthlyConversions > 0 ? Math.round(proj.monthlyRevenue / proj.monthlyConversions) : '—';
      const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

      // Status badge
      const statusBadge = isApproved
        ? '<span class="badge badge-published">Approved · $' + approvedBudget + '/day</span>'
        : '<span class="badge badge-draft">Proposed</span>';

      // Budget cell — editable for proposed, display-only for approved
      // JSON.stringify produces double-quoted keys — must encode as &quot; for use inside a double-quoted HTML attribute
      const projJson = JSON.stringify(proj).replace(/"/g, '&quot;');
      const budgetCell = isApproved
        ? '<div class="metric budget-metric"><div class="metric-label">Approved Budget</div><div class="metric-value">$' + approvedBudget + ' <span class="metric-unit">/day</span></div><div class="metric-note">$' + (approvedBudget * 30).toFixed(0) + '/mo</div></div>'
        : '<div class="metric budget-metric"><div class="metric-label">Daily Budget</div><div class="budget-row"><span style="font-size:14px;font-weight:700;color:var(--muted)">$</span><input class="budget-input" id="budget-' + esc(c.id) + '" type="number" min="1" step="0.5" value="' + sugBudget + '" oninput="handleBudgetChange(&apos;' + esc(c.id) + '&apos;)"><button class="update-btn" id="upd-btn-' + esc(c.id) + '" data-sug="' + sugBudget + '" data-proj="' + projJson + '" onclick="updateProjections(&apos;' + esc(c.id) + '&apos;)">Update</button></div><div class="metric-note">$' + (sugBudget * 30).toFixed(0) + '/mo suggested</div></div>';

      // Ad groups pills
      const adGroupPills = (p.adGroups || []).map(ag =>
        '<span class="adgroup-pill">' + esc(ag.name) + ' <span class="adgroup-kw">· ' + (ag.keywords || []).length + ' kw</span></span>'
      ).join('');
      const negCount = (p.negativeKeywords || []).length;

      // Actions row
      const actionsHtml = isApproved
        ? '<button class="btn-launch" onclick="launchCampaign(&apos;' + esc(c.id) + '&apos;)">▶ Launch in Google Ads</button>' +
          '<button class="btn-dismiss" onclick="dismissCampaign(&apos;' + esc(c.id) + '&apos;)">Dismiss</button>' +
          '<span class="proposal-action-note">Budget approved — ready to go live</span>'
        : '<button class="btn-approve" onclick="approveCampaign(&apos;' + esc(c.id) + '&apos;)">✓ Approve &amp; Set Budget</button>' +
          '<button class="btn-dismiss" onclick="dismissCampaign(&apos;' + esc(c.id) + '&apos;)">Dismiss</button>' +
          '<span class="proposal-action-note">Approval sets budget — launch is a separate step</span>';

      return (
        '<div class="proposal" id="prop-' + esc(c.id) + '">' +

        // 1. Header
        '<div class="proposal-head">' +
          '<div>' +
            '<div class="proposal-name">' + esc(p.campaignName) + '</div>' +
            '<div class="proposal-sub">' + esc(p.landingPage || '') + '</div>' +
            '<div class="proposal-tags"><span class="badge badge-scheduled">' + esc(p.network || 'Search') + '</span>' + statusBadge + '</div>' +
          '</div>' +
          '<div style="margin-left:auto;font-size:11px;color:var(--muted)">' + esc(dateStr) + '</div>' +
        '</div>' +

        // 2. Metrics row
        '<div class="metrics-row">' +
          budgetCell +
          '<div class="metric"><div class="metric-label">Est. Clicks/day</div><div class="metric-value" id="clicks-' + esc(c.id) + '">' + (proj.dailyClicks || '—') + ' <span class="metric-unit">clicks</span></div><div class="metric-note">CTR ' + ((proj.ctr || 0) * 100).toFixed(1) + '%</div></div>' +
          '<div class="metric"><div class="metric-label">Monthly Cost</div><div class="metric-value" id="cost-' + esc(c.id) + '">$' + (proj.monthlyCost || '—') + '</div><div class="metric-note">$' + (proj.cpc || '—') + ' avg CPC</div></div>' +
          '<div class="metric"><div class="metric-label">Est. Conversions</div><div class="metric-value" id="conv-' + esc(c.id) + '">' + (proj.monthlyConversions || '—') + ' <span class="metric-unit">/mo</span></div><div class="metric-note">CVR ' + ((proj.cvr || 0) * 100).toFixed(1) + '%</div></div>' +
          '<div class="metric"><div class="metric-label">Est. Revenue</div><div class="metric-value" style="color:var(--green)" id="rev-' + esc(c.id) + '">$' + (proj.monthlyRevenue || '—') + '</div><div class="metric-note">~$' + aov + '/conversion</div></div>' +
        '</div>' +

        // 3. Rationale
        '<div class="rationale-row"><div class="rationale-label">Why this campaign</div><div class="rationale-text">' + esc(c.rationale || '') + '</div></div>' +

        // 4. Ad groups
        '<div class="adgroups-row"><span class="adgroups-label">Ad Groups</span>' + adGroupPills + (negCount > 0 ? '<span style="font-size:11px;color:var(--muted);margin-left:auto">' + negCount + ' neg. keywords</span>' : '') + '</div>' +

        // 5. Actions
        '<div class="proposal-actions">' + actionsHtml + '</div>' +

        '</div>'
      );
    }).join('');
  } else { propCard.style.display = 'none'; }
```

- [ ] **Step 2: Verify no syntax errors and new classes appear in page source**

```bash
node --check agents/dashboard/index.js && echo "syntax OK"
node agents/dashboard/index.js &
sleep 1
curl -s -u "sean:$(grep DASHBOARD_PASSWORD .env | cut -d= -f2)" http://localhost:4242/ | grep -c "\.metrics-row"
kill %1
```

Expected: `syntax OK`, then `1` (the CSS class definition is present in the server-rendered `<style>` block)

---

### Task 4: Add `handleBudgetChange()` and `updateProjections()`, update `approveCampaign()`

**Files:**
- Modify: `agents/dashboard/index.js` lines ~2375–2383

- [ ] **Step 1: Replace `approveCampaign()` and add two new functions**

Find:
```js
async function approveCampaign(id) {
  const budget = parseFloat(document.getElementById('budget-' + id)?.value);
  if (!budget || budget <= 0) { alert('Enter a valid budget before approving.'); return; }
  try {
    const res = await fetch('/api/campaigns/' + encodeURIComponent(id) + '/approve', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvedBudget: budget }) });
    if (!res.ok) throw new Error(await res.text());
    document.getElementById('approve-btn-' + id).disabled = true;
    document.getElementById('launch-row-' + id).style.display = '';
  } catch (e) { alert('Approve failed: ' + e.message); }
}
```

Replace with:
```js
function handleBudgetChange(id) {
  document.getElementById('upd-btn-' + id)?.classList.add('visible');
}

function updateProjections(id) {
  const input = document.getElementById('budget-' + id);
  const btn   = document.getElementById('upd-btn-' + id);
  const newBudget      = parseFloat(input?.value);
  const suggestedBudget = parseFloat(btn?.dataset.sug);
  const baseProj        = JSON.parse(btn?.dataset.proj || '{}');
  if (!newBudget || newBudget <= 0 || !suggestedBudget) return;
  const ratio = newBudget / suggestedBudget;
  const clicks = Math.round((baseProj.dailyClicks || 0) * ratio);
  const cost   = Math.round((baseProj.monthlyCost || 0) * ratio);
  const conv   = Math.round((baseProj.monthlyConversions || 0) * ratio);
  const rev    = Math.round((baseProj.monthlyRevenue || 0) * ratio);
  const clickEl = document.getElementById('clicks-' + id);
  const costEl  = document.getElementById('cost-' + id);
  const convEl  = document.getElementById('conv-' + id);
  const revEl   = document.getElementById('rev-' + id);
  if (clickEl) clickEl.innerHTML = clicks + ' <span class="metric-unit">clicks</span>';
  if (costEl)  costEl.textContent = '$' + cost;
  if (convEl)  convEl.innerHTML = conv + ' <span class="metric-unit">/mo</span>';
  if (revEl)   revEl.textContent = '$' + rev;
  document.getElementById('upd-btn-' + id)?.classList.remove('visible');
}

async function approveCampaign(id) {
  const budget = parseFloat(document.getElementById('budget-' + id)?.value);
  if (!budget || budget <= 0) { alert('Enter a valid budget before approving.'); return; }
  try {
    const res = await fetch('/api/campaigns/' + encodeURIComponent(id) + '/approve', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvedBudget: budget }) });
    if (!res.ok) throw new Error(await res.text());
    loadCampaignCards();
  } catch (e) { alert('Approve failed: ' + e.message); }
}
```

Note: `approveCampaign` now calls `loadCampaignCards()` on success (re-renders the card from server state with the approved badge and Launch button) instead of manually toggling DOM elements.

- [ ] **Step 2: Verify no syntax errors**

```bash
node --check agents/dashboard/index.js && echo "OK"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: redesign campaign proposal cards with full data, budget editor, projection recalculation"
```

---

### Task 5: Restart dashboard and manually verify

- [ ] **Step 1: Kill any running dashboard process and restart**

```bash
pkill -f "node agents/dashboard/index.js" 2>/dev/null || true
sleep 1 && node agents/dashboard/index.js &
```

- [ ] **Step 2: Open the dashboard in a browser**

Open [http://localhost:4242](http://localhost:4242), go to the **Ads** tab.

Verify all of the following:

1. **Three proposal cards render** — each with header, metrics row, full rationale, ad groups, and action buttons
2. **Full rationale visible** — no truncation at 120 chars
3. **Metrics row** shows: Daily Budget (editable input), Est. Clicks/day, Monthly Cost, Est. Conversions, Est. Revenue (green)
4. **Status badges** match: "Proposed" (amber) for proposed status, "Approved · $N/day" (green) for approved status
5. **Budget change → Update button appears** — type a new number in the budget field, verify "Update" button appears
6. **Click Update → projections recalculate** — numbers in Clicks/Cost/Conversions/Revenue change proportionally
7. **Approve a proposal** — click "✓ Approve & Set Budget" on a proposed card, verify it reloads showing "Approved · $N/day" badge and "▶ Launch in Google Ads" button
8. **Old CSS classes gone** — open browser DevTools, confirm no elements use `.camp-proposal`, `.camp-proposal-name`, `.camp-budget-input`

- [ ] **Step 3: Run test suite to confirm no regressions**

```bash
npm test
```

Expected: `38 pass, 0 fail`

- [ ] **Step 4: Merge to main**

```bash
git checkout main
git merge feature/campaign-card-redesign
git branch -d feature/campaign-card-redesign
```
