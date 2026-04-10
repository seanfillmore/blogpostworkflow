let data = null;

let activeTab = 'seo';

var chatOpen = new Set();

function switchTab(name, btn) {
  activeTab = name;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-pill').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.classList.add('active');
  btn.classList.add('active');
  // Show/hide CRO date filter
  document.getElementById('cro-filter-bar').style.display = (name === 'cro' || name === 'ads') ? '' : 'none';
  // Show/hide tab action groups
  ['seo','cro','optimize','ads','creatives'].forEach(function(t) {
    const g = document.getElementById('tab-actions-' + t);
    if (g) g.style.display = t === name ? '' : 'none';
  });
  // Update hero KPIs for this tab
  if (data) renderHeroKpis(data);
  if (name === 'optimize' && data) renderOptimizeTab(data);
  if (name === 'ad-intelligence') renderAdIntelligenceTab();
  if (name === 'creatives') renderCreativesTab();
  // Update chat sidebar when tab switches
  if (tabChatOpen) {
    var chatTitle = document.getElementById('tab-chat-title');
    if (chatTitle) chatTitle.textContent = '\\u2736 ' + (TAB_CHAT_NAMES[name] || name) + ' Chat';
    ['seo','cro','ads','optimize'].forEach(function(t) {
      var btn2 = document.getElementById('btn-chat-' + t);
      if (btn2) { if (t === name) btn2.classList.add('active'); else btn2.classList.remove('active'); }
    });
    renderTabChatMessages();
  }
  // Sync mobile tab bar active state
  document.querySelectorAll('.mobile-tab').forEach(function(t) { t.classList.remove('active'); });
  var mobileNames = ['seo','cro','ads','creatives'];
  var mobileIdx = mobileNames.indexOf(name);
  var mobileTabs = document.querySelectorAll('.mobile-tab');
  if (mobileIdx >= 0 && mobileTabs[mobileIdx]) {
    mobileTabs[mobileIdx].classList.add('active');
  } else if (mobileTabs.length > 4) {
    mobileTabs[4].classList.add('active');
  }
}

// ── Mobile responsive helpers ────────────────────────────────────────────────

function mobileTabSwitch(name, btn) {
  // Reuse existing switchTab — find the matching desktop pill to pass as btn arg
  var pill = document.querySelector('.tab-pill[onclick*="' + name + '"]');
  if (pill) switchTab(name, pill);
  // Update mobile tab bar active state
  document.querySelectorAll('.mobile-tab').forEach(function(t) { t.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  // If opened from More menu, highlight the More button
  if (!btn) {
    var moreBtn = document.querySelector('#mobile-tab-bar .mobile-tab:last-child');
    if (moreBtn) moreBtn.classList.add('active');
  }
}

function toggleMoreMenu() {
  var menu = document.getElementById('mobile-more-menu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? '' : 'none';
}

function toggleKanbanAccordion(header) {
  var col = header.closest('.kanban-col');
  if (!col) return;
  var wasExpanded = col.classList.contains('expanded');
  // Collapse all columns first (single-expand behavior)
  document.querySelectorAll('.kanban-col.expanded').forEach(function(c) { c.classList.remove('expanded'); });
  // Toggle clicked column
  if (!wasExpanded) col.classList.add('expanded');
}

function renderHeroKpis(d) {
  const kpis = activeTab === 'cro'       ? buildCroKpis(d)
             : activeTab === 'ads'       ? buildAdsKpis(d)
             : activeTab === 'optimize'  ? buildOptimizeKpis(d)
             : activeTab === 'creatives' ? buildCreativesKpis()
             : buildSeoKpis(d);
  document.getElementById('hero-kpis').innerHTML = kpis.map(k =>
    '<div class="hero-kpi">' +
    '<div class="hero-kpi-value" style="color:' + k.color + '">' + k.value + '</div>' +
    '<div class="hero-kpi-label">' + k.label + '</div>' +
    '</div>'
  ).join('');
}

function buildSeoKpis(d) {
  const c = d.pipeline?.counts || {};
  const r = d.rankings || {};
  const page1 = r.summary?.page1 ?? '—';
  const rankItems = r.items.filter(x => x.change != null);
  const avgChange = rankItems.length
    ? (rankItems.reduce((s, x) => s + x.change, 0) / rankItems.length).toFixed(1)
    : null;
  const gscClicks = d.cro?.gscAll?.[0]?.summary?.clicks ?? null;
  return [
    { label: 'Published',   value: c.published || 0,                                          color: '#10b981' },
    { label: 'Scheduled',   value: c.scheduled  || 0,                                          color: '#818cf8' },
    { label: 'Pg 1 KWs',    value: page1,                                                      color: '#f59e0b' },
    { label: 'Avg Rank Δ',  value: avgChange != null ? (avgChange > 0 ? '+' : '') + avgChange : '—', color: '#c084fc' },
    { label: 'GSC Clicks',  value: gscClicks != null ? gscClicks.toLocaleString() : '—',       color: '#38bdf8' },
  ];
}

function buildCroKpis(d) {
  const cro = d.cro || {};
  const ga4 = cro.ga4All?.[0];
  const sh  = cro.shopifyAll?.[0];
  const cl  = cro.clarityAll?.[0];
  return [
    { label: 'Conv. Rate',  value: ga4?.conversionRate != null ? (ga4.conversionRate * 100).toFixed(1) + '%' : '—', color: '#10b981' },
    { label: 'Avg Order',   value: sh?.orders?.aov != null ? '$' + Math.round(sh.orders.aov) : '—',                  color: '#fb923c' },
    { label: 'Bounce Rate', value: ga4?.bounceRate != null ? (ga4.bounceRate * 100).toFixed(1) + '%' : '—',           color: '#ef4444' },
    { label: 'Sessions',    value: cl?.sessions?.real ?? ga4?.sessions ?? '—',                                        color: '#38bdf8' },
    { label: 'Cart Abandon',value: sh?.cartAbandonmentRate != null ? (sh.cartAbandonmentRate * 100).toFixed(1) + '%' : '—', color: '#f59e0b' },
  ];
}

function buildAdsKpis(d) {
  const snap = d.googleAdsAll?.[0];
  return [
    { label: 'Ad Spend',     value: snap?.spend != null ? '$' + snap.spend.toFixed(2) : '—',            color: '#fb923c' },
    { label: 'Impressions',  value: snap?.impressions != null ? snap.impressions.toLocaleString() : '—', color: '#38bdf8' },
    { label: 'Clicks',       value: snap?.clicks != null ? snap.clicks.toLocaleString() : '—',           color: '#818cf8' },
    { label: 'CTR',          value: snap?.ctr != null ? (snap.ctr * 100).toFixed(2) + '%' : '—',         color: '#f59e0b' },
    { label: 'ROAS',         value: snap?.roas != null ? snap.roas.toFixed(2) + 'x' : '—',               color: '#10b981' },
  ];
}

function renderOptimizeTab(d) {
  const briefs = d.briefs || [];

  const pending  = briefs.filter(b => (b.proposed_changes || []).some(c => c.status === 'pending'));
  const approved = briefs.filter(b => {
    const ch = b.proposed_changes || [];
    return !ch.some(c => c.status === 'pending') && ch.some(c => c.status === 'approved') && !ch.some(c => c.status === 'applied');
  });
  const applied  = briefs.filter(b => {
    const ch = b.proposed_changes || [];
    return ch.some(c => c.status === 'applied') && !ch.some(c => c.status === 'approved');
  });

  document.getElementById('tab-optimize').innerHTML =
    renderPerformanceQueueCard(d) +
    renderCannibalizationCard(d) +
    renderIndexingCard(d) +
    renderActionRequired(d) +
    renderQuickWinCard(d) +
    renderGscOpportunityCard(d) +
    renderLegacyTriageCard(d) +
    renderClusterAuthorityCard(d) +
    '<div class="card"><div class="card-header accent-purple"><h2>Legacy Optimizer Briefs</h2></div>' +
    '<div class="card-body">' +
    '<div class="kanban-optimize">' +
      '<div class="kanban-optimize-col">' +
        '<h3>Pending Review <span class="badge">' + pending.length + '</span></h3>' +
        (pending.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">No pending briefs</div>') +
      '</div>' +
      '<div class="kanban-optimize-col">' +
        '<h3>Approved <span class="badge">' + approved.length + '</span></h3>' +
        (approved.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">None approved yet</div>') +
      '</div>' +
      '<div class="kanban-optimize-col">' +
        '<h3>Applied <span class="badge">' + applied.length + '</span></h3>' +
        (applied.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">None applied yet</div>') +
      '</div>' +
    '</div></div></div>' +
    '<pre id="run-log-agents-competitor-intelligence-index-js" class="run-log" style="display:none"></pre>';
}

// ── Performance-driven SEO engine cards ───────────────────────────────────────

function renderCannibalizationCard(d) {
  var c = d.cannibalization;
  if (!c || !c.conflicts || c.conflicts.length === 0) return '';
  return '<div class="card"><div class="card-header accent-red"><h2>Keyword Cannibalization <span class="badge">' + c.conflict_count + '</span></h2></div>' +
    '<div class="card-body">' +
    '<p style="color:#6b7280;margin-bottom:12px">' + c.auto_resolved + ' auto-resolved, ' + c.recommended + ' recommendations</p>' +
    '<table class="data-table"><thead><tr><th>Query</th><th>Impressions</th><th>URLs</th><th>Type</th></tr></thead><tbody>' +
    c.conflicts.slice(0, 10).map(function(conflict) {
      var urls = conflict.urls.map(function(u) {
        return '<div style="font-size:12px">' + u.type + ' #' + Math.round(u.position) + ' — <a href="' + u.url + '" target="_blank">' + u.url.split('/').pop() + '</a></div>';
      }).join('');
      return '<tr><td><strong>' + conflict.query + '</strong></td><td>' + conflict.total_impressions + '</td><td>' + urls + '</td><td>' + conflict.conflict_type + '</td></tr>';
    }).join('') +
    '</tbody></table></div></div>';
}

function renderPerformanceQueueCard(d) {
  const items = d.performanceQueue || [];
  if (items.length === 0) return '';
  const cards = items.map(function(i) {
    var statusClass = 'status-' + i.status;
    return '<div class="queue-item ' + statusClass + '">' +
      '<div class="queue-item-head">' +
        '<span class="queue-trigger trigger-' + esc(i.trigger) + '">' + esc(i.trigger) + '</span>' +
        '<span class="queue-title">' + esc(i.title) + '</span>' +
        '<span class="queue-status">' + esc(i.status) + '</span>' +
      '</div>' +
      '<div class="queue-summary">' +
        '<div><strong>What changed:</strong> ' + esc(i.summary.what_changed) + '</div>' +
        '<div><strong>Why:</strong> ' + esc(i.summary.why) + '</div>' +
        '<div><strong>Projected impact:</strong> ' + esc(i.summary.projected_impact) + '</div>' +
      '</div>' +
      '<div class="queue-actions">' +
        (i.status === 'pending' || i.status === 'approved'
          ? '<button class="btn-approve" onclick="approveQueueItem(\'' + esc(i.slug) + '\')"' + (i.status === 'approved' ? ' disabled' : '') + '>' + (i.status === 'approved' ? 'Approved' : 'Approve') + '</button>' +
            '<button class="btn-sm" onclick="openFeedbackEditor(\'' + esc(i.slug) + '\')">Feedback</button>' +
            '<button class="btn-sm" onclick="previewQueueItem(\'' + esc(i.slug) + '\')">Preview</button>'
          : '<button class="btn-sm" onclick="previewQueueItem(\'' + esc(i.slug) + '\')">Preview</button>') +
      '</div>' +
      '<div id="feedback-editor-' + esc(i.slug) + '" class="feedback-editor" style="display:none">' +
        '<textarea id="feedback-text-' + esc(i.slug) + '" placeholder="Tell the engine what to change..."></textarea>' +
        '<div class="feedback-buttons">' +
          '<button class="btn-sm" onclick="closeFeedbackEditor(\'' + esc(i.slug) + '\')">Cancel</button>' +
          '<button class="btn-primary" onclick="submitFeedback(\'' + esc(i.slug) + '\')">Submit feedback</button>' +
        '</div>' +
      '</div>' +
      (i.feedback ? '<div class="queue-pending-feedback">Pending feedback: ' + esc(i.feedback) + '</div>' : '') +
    '</div>';
  }).join('');
  return '<div class="card"><div class="card-header accent-indigo">' +
      '<h2>Optimization Queue</h2>' +
      '<span class="card-subtitle">' + items.length + ' item' + (items.length > 1 ? 's' : '') + ' awaiting review</span>' +
    '</div><div class="card-body">' + cards + '</div></div>';
}

async function approveQueueItem(slug) {
  var res = await fetch('/api/performance-queue/' + encodeURIComponent(slug) + '/approve', { method: 'POST' });
  if (res.ok) loadData();
}

function openFeedbackEditor(slug) {
  document.getElementById('feedback-editor-' + slug).style.display = 'block';
}

function closeFeedbackEditor(slug) {
  document.getElementById('feedback-editor-' + slug).style.display = 'none';
}

async function submitFeedback(slug) {
  var txt = document.getElementById('feedback-text-' + slug).value.trim();
  if (!txt) { alert('Please enter feedback first.'); return; }
  var res = await fetch('/api/performance-queue/' + encodeURIComponent(slug) + '/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback: txt }),
  });
  if (res.ok) {
    alert('Feedback saved. The next engine run will apply it.');
    loadData();
  }
}

function previewQueueItem(slug) {
  window.open('/api/performance-queue/' + encodeURIComponent(slug) + '/html', '_blank');
}

function renderIndexingCard(d) {
  const idx = d.indexing;
  const queue = (d.indexingQueue && d.indexingQueue.items) || [];
  const pendingApproval = queue.filter((q) => q.status === 'pending_approval');

  if (!idx) {
    return '<div class="card"><div class="card-header accent-sky"><h2>&#128065; Indexing Status</h2></div>' +
      '<div class="card-body"><div class="empty-state">No indexing check yet. Run the indexing-checker.</div></div></div>';
  }

  const byState = idx.by_state || {};
  const total = idx.total_checked || 0;
  const indexed = byState.indexed || 0;
  const actionable = idx.actionable_count || 0;
  const accent = actionable > 0 ? 'accent-red' : 'accent-sky';

  // State pills
  const pills = Object.entries(byState)
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => {
      const cls = state === 'indexed' ? 'weight-pos' : 'weight-neg';
      return '<span class="weight-pill ' + cls + '" style="margin-right:6px">' + esc(state) + ': ' + count + '</span>';
    }).join('');

  // Pending approval queue (Tier 2)
  let queueRows = '';
  if (pendingApproval.length > 0) {
    queueRows = pendingApproval.map((q) => '<div class="action-row">' +
      '<div class="action-head">' +
        '<span class="verdict-pill verdict-refresh">Tier 2</span>' +
        '<span class="action-title">' + esc(q.title || q.slug) + '</span>' +
        '<span class="action-age">' + (q.age_days || '?') + 'd &middot; ' + esc(q.state) + '</span>' +
      '</div>' +
      '<div class="action-reason">Not indexed after ' + (q.age_days || '?') + ' days. Tier 1 sitemap ping did not resolve. Submit via Google Indexing API?</div>' +
      '<div class="action-buttons">' +
        '<button class="btn-primary" onclick="approveIndexingSubmit(' + "'" + esc(q.slug) + "'" + ')">Submit to Indexing API</button>' +
        '<button class="btn-sm" onclick="dismissIndexingSubmit(' + "'" + esc(q.slug) + "'" + ')">Dismiss</button>' +
      '</div>' +
    '</div>').join('');
  }

  // Actionable critical items (Tier 3 manual fixes)
  const critical = (idx.results || []).filter((r) => r.verdict && r.verdict.severity === 'critical' && !['resubmit_sitemap', 'submit_indexing_api'].includes(r.verdict.action));
  let criticalRows = '';
  if (critical.length > 0) {
    criticalRows = critical.map((r) => '<div class="action-row">' +
      '<div class="action-head">' +
        '<span class="verdict-pill verdict-blocked">Manual Fix</span>' +
        '<span class="action-title">' + esc(r.title || r.slug) + '</span>' +
        '<span class="action-age">' + esc(r.verdict.action) + '</span>' +
      '</div>' +
      '<div class="action-reason">' + esc(r.state) + ' &mdash; ' + esc(r.coverage_state || '') + (r.canonical_mismatch ? ' &middot; Google canonical: <code>' + esc(r.google_canonical || '') + '</code>' : '') + '</div>' +
      '<div class="action-buttons"><a class="btn-secondary" href="' + esc(r.url) + '" target="_blank">Open post</a></div>' +
    '</div>').join('');
  }

  const quotaNote = idx.quota && idx.quota.submission
    ? '<span class="card-subtitle">Indexing API quota: ' + idx.quota.submission.used + '/' + idx.quota.submission.cap + ' used today</span>'
    : '';

  return '<div class="card"><div class="card-header ' + accent + '">' +
      '<h2>&#128065; Indexing Status (' + indexed + '/' + total + ' indexed)</h2>' +
      quotaNote +
    '</div><div class="card-body">' +
      '<div style="margin-bottom:12px">' + pills + '</div>' +
      (queueRows ? '<h3 style="font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:8px 0">Pending Approval</h3>' + queueRows : '') +
      (criticalRows ? '<h3 style="font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:12px 0 8px">Manual Fixes Needed</h3>' + criticalRows : '') +
      (queueRows || criticalRows ? '' : '<div class="empty-state" style="padding:12px 0">All posts are either indexed or within their patience window.</div>') +
    '</div></div>';
}

async function approveIndexingSubmit(slug) {
  if (!confirm('Submit "' + slug + '" to the Google Indexing API?')) return;
  const res = await fetch('/api/indexing-queue/' + encodeURIComponent(slug) + '/approve', { method: 'POST' });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let log = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    log += decoder.decode(value);
  }
  alert('Submission complete. Check daily digest for result.\n\n' + log.slice(-400));
  loadData();
}

async function dismissIndexingSubmit(slug) {
  if (!confirm('Dismiss indexing submission for "' + slug + '"?')) return;
  await fetch('/api/indexing-queue/' + encodeURIComponent(slug) + '/dismiss', { method: 'POST' });
  loadData();
}

function renderActionRequired(d) {
  const flops = (d.postPerformance && d.postPerformance.action_required) || [];
  if (flops.length === 0) return '';
  const rows = flops.map(f => {
    const verdictClass = f.verdict === 'BLOCKED' ? 'verdict-blocked'
                      : f.verdict === 'REFRESH' ? 'verdict-refresh'
                      : 'verdict-demote';
    return '<div class="action-row">' +
      '<div class="action-head">' +
        '<span class="verdict-pill ' + verdictClass + '">' + esc(f.verdict) + '</span>' +
        '<span class="action-title">' + esc(f.title || f.slug) + '</span>' +
        '<span class="action-age">' + f.milestone + 'd</span>' +
      '</div>' +
      '<div class="action-reason">' + esc(f.reason || '') + '</div>' +
      '<div class="action-buttons">' +
        (f.url ? '<a href="' + esc(f.url) + '" target="_blank" class="btn-secondary">Open post</a>' : '') +
        '<button class="btn-primary" onclick="refreshSlug(' + "'" + esc(f.slug) + "'" + ')">Refresh this post</button>' +
      '</div>' +
    '</div>';
  }).join('');
  return '<div class="card card-action"><div class="card-header accent-red">' +
      '<h2>&#9888; Action Required &mdash; ' + flops.length + ' underperforming post' + (flops.length > 1 ? 's' : '') + '</h2>' +
    '</div><div class="card-body">' + rows + '</div></div>';
}

function renderQuickWinCard(d) {
  const qw = d.quickWins;
  if (!qw || !qw.top || qw.top.length === 0) {
    return '<div class="card"><div class="card-header accent-green"><h2>Quick-Win Targets</h2></div>' +
      '<div class="card-body"><div class="empty-state">No page-2 candidates right now. Run the rank tracker to refresh.</div></div></div>';
  }
  const rows = qw.top.slice(0, 10).map((c, i) => {
    const ctrPct = (c.ctr * 100).toFixed(1);
    return '<tr>' +
      '<td class="col-rank">' + (i + 1) + '</td>' +
      '<td class="col-title">' + esc(c.title || c.slug) + '</td>' +
      '<td class="col-pos">pos ' + c.position + '</td>' +
      '<td class="col-impr">' + c.impressions.toLocaleString() + '</td>' +
      '<td class="col-ctr">' + ctrPct + '%</td>' +
      '<td class="col-query">' + (c.top_query ? esc(c.top_query) : '&mdash;') + '</td>' +
      '<td class="col-action"><button class="btn-sm" onclick="refreshSlug(' + "'" + esc(c.slug) + "'" + ')">Refresh</button></td>' +
    '</tr>';
  }).join('');
  const subtitle = qw.candidate_count + ' total page-2 candidates &middot; showing top ' + Math.min(qw.top.length, 10);
  return '<div class="card"><div class="card-header accent-green">' +
      '<h2>&#128640; Quick-Win Targets</h2>' +
      '<span class="card-subtitle">' + subtitle + '</span>' +
    '</div><div class="card-body"><table class="data-table">' +
      '<thead><tr><th>#</th><th>Post</th><th>Pos</th><th>Impr</th><th>CTR</th><th>Top query</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table></div></div>';
}

function renderGscOpportunityCard(d) {
  const g = d.gscOpportunity;
  if (!g) return '';
  const lowCtr = (g.low_ctr || []).slice(0, 10);
  const page2  = (g.page_2  || []).slice(0, 10);
  const unmapped = (g.unmapped || []).slice(0, 10);
  const section = (label, items, showCtr) => {
    if (items.length === 0) return '<div class="opp-section"><h3>' + label + '</h3><div class="empty-state">None.</div></div>';
    const rows = items.map(r => '<tr>' +
      '<td>' + esc(r.keyword) + '</td>' +
      '<td>' + r.impressions.toLocaleString() + '</td>' +
      (showCtr ? '<td>' + ((r.ctr || 0) * 100).toFixed(1) + '%</td>' : '') +
      '<td>' + (r.position != null ? r.position.toFixed(1) : '&mdash;') + '</td>' +
    '</tr>').join('');
    return '<div class="opp-section"><h3>' + label + '</h3>' +
      '<table class="data-table"><thead><tr><th>Query</th><th>Impr</th>' + (showCtr ? '<th>CTR</th>' : '') + '<th>Pos</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  };
  return '<div class="card"><div class="card-header accent-sky">' +
      '<h2>GSC Opportunities</h2>' +
    '</div><div class="card-body opp-grid">' +
      section('Low-CTR (rewrite title/meta)', lowCtr, true) +
      section('Page-2 (quick-win candidates)', page2, true) +
      section('Unmapped (new-topic candidates)', unmapped, false) +
    '</div></div>';
}

function renderLegacyTriageCard(d) {
  var t = d.legacyTriage;
  if (!t) {
    return '<div class="card"><div class="card-header accent-amber"><h2>Legacy Post Triage</h2></div>' +
      '<div class="card-body"><div class="empty-state">No triage data. <button class="btn-sm" onclick="runAgent(\'agents/legacy-triage/index.js\')">Run triage</button></div></div></div>';
  }
  var c = t.counts || {};
  var pills =
    '<span class="weight-pill weight-pos" style="margin-right:6px">Winners: ' + (c.winner||0) + '</span>' +
    '<span class="weight-pill" style="margin-right:6px;background:#dbeafe;color:#1e40af">Rising: ' + (c.rising||0) + '</span>' +
    '<span class="weight-pill weight-neg" style="margin-right:6px">Flops: ' + (c.flop||0) + '</span>' +
    '<span class="weight-pill" style="margin-right:6px;background:#fef3c7;color:#92400e">Broken: ' + (c.broken||0) + '</span>';

  var topFlops = (t.results||[]).filter(function(r){ return r.bucket === 'flop'; }).slice(0, 5);
  var topRising = (t.results||[]).filter(function(r){ return r.bucket === 'rising'; }).slice(0, 5);
  var broken = (t.results||[]).filter(function(r){ return r.bucket === 'broken'; });

  var flopRows = topFlops.length === 0 ? '<div class="empty-state">No flops.</div>'
    : '<table class="data-table"><thead><tr><th>Post</th><th>Words</th><th>Reason</th></tr></thead><tbody>' +
      topFlops.map(function(r) {
        return '<tr><td class="col-title">' + esc(r.title) + '</td><td>' + r.words + '</td><td class="col-reason">' + esc(r.reason.slice(0, 60)) + '</td></tr>';
      }).join('') + '</tbody></table>';

  var risingRows = topRising.length === 0 ? ''
    : '<h3 style="font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:12px 0 6px">Top Rising (meta-only)</h3>' +
      '<table class="data-table"><thead><tr><th>Post</th><th>Pos</th><th>Impr</th></tr></thead><tbody>' +
      topRising.map(function(r) {
        return '<tr><td class="col-title">' + esc(r.title) + '</td><td>' + (r.position ? Math.round(r.position) : '?') + '</td><td>' + r.impressions + '</td></tr>';
      }).join('') + '</tbody></table>';

  var brokenRows = broken.length === 0 ? ''
    : '<h3 style="font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:12px 0 6px">Broken (manual fix)</h3>' +
      broken.map(function(r) {
        return '<div class="action-row"><div class="action-head"><span class="verdict-pill verdict-blocked">Broken</span><span class="action-title">' + esc(r.title) + '</span></div><div class="action-reason">' + esc(r.reason) + '</div></div>';
      }).join('');

  return '<div class="card"><div class="card-header accent-amber">' +
      '<h2>Legacy Post Triage (' + t.total + ' posts)</h2>' +
      '<button class="btn-sm" onclick="runAgent(\'agents/legacy-triage/index.js\')" style="margin-left:auto">Re-run</button>' +
    '</div><div class="card-body">' +
      '<div style="margin-bottom:12px">' + pills + '</div>' +
      '<h3 style="font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:0 0 6px">Top Flops (rewrite candidates)</h3>' +
      flopRows +
      risingRows +
      brokenRows +
    '</div></div>';
}

function renderClusterAuthorityCard(d) {
  const cw = d.clusterWeights;
  if (!cw || !cw.clusters) return '';
  const entries = Object.entries(cw.clusters)
    .map(([name, c]) => ({ name, ...c }))
    .sort((a, b) => b.weight - a.weight);
  if (entries.length === 0) return '';
  const rows = entries.map(c => {
    const weightClass = c.weight > 0 ? 'weight-pos' : c.weight < 0 ? 'weight-neg' : 'weight-zero';
    const sign = c.weight > 0 ? '+' : '';
    return '<tr>' +
      '<td class="col-cluster">' + esc(c.name) + '</td>' +
      '<td><span class="weight-pill ' + weightClass + '">' + sign + c.weight + '</span></td>' +
      '<td>' + c.post_count + '</td>' +
      '<td>' + (c.median_position != null ? c.median_position : '&mdash;') + '</td>' +
      '<td>' + c.page_1_count + '</td>' +
      '<td class="col-reason">' + (c.reasons || []).map(esc).join('; ') + '</td>' +
    '</tr>';
  }).join('');
  return '<div class="card"><div class="card-header accent-purple">' +
      '<h2>Cluster Authority Weights</h2>' +
      '<span class="card-subtitle">Page-1 clusters get +2, drag clusters get &minus;3. Used by the strategist.</span>' +
    '</div><div class="card-body"><table class="data-table">' +
      '<thead><tr><th>Cluster</th><th>Weight</th><th>Posts</th><th>Median pos</th><th>Page 1</th><th>Reason</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table></div></div>';
}

/**
 * Trigger a refresh of a specific post via the refresh-runner agent.
 * Streams the run output into a log area at the bottom of the page.
 */
function refreshSlug(slug) {
  if (!confirm('Refresh "' + slug + '"? This runs content-refresher + editor. It does not publish.')) return;
  const logId = 'refresh-log-' + slug;
  let logEl = document.getElementById(logId);
  if (!logEl) {
    const container = document.getElementById('tab-optimize');
    const wrap = document.createElement('div');
    wrap.className = 'card';
    wrap.innerHTML = '<div class="card-header accent-amber"><h2>Refreshing ' + esc(slug) + '</h2></div>' +
      '<div class="card-body"><pre id="' + logId + '" class="run-log"></pre></div>';
    container.insertBefore(wrap, container.firstChild);
    logEl = document.getElementById(logId);
  }
  logEl.textContent = 'Starting refresh...\n';
  fetch('/run-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: 'agents/refresh-runner/index.js', args: [slug] }),
  }).then(res => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('data: ')) {
            logEl.textContent += line.slice(6) + '\n';
            logEl.scrollTop = logEl.scrollHeight;
          }
        }
        read();
      });
    }
    read();
  });
}

function renderBriefCard(b) {
  const pendingCount  = (b.proposed_changes || []).filter(c => c.status === 'pending').length;
  const approvedCount = (b.proposed_changes || []).filter(c => c.status === 'approved').length;
  const topTV = b.competitors && b.competitors[0] && b.competitors[0].traffic_value
    ? '$' + ((b.competitors[0].traffic_value) / 100).toLocaleString() : '\u2014';
  return '<div class="brief-card" onclick="toggleBriefDetail(&apos;' + esc(b.slug) + '&apos;)">' +
      '<div class="brief-card-title">' + esc(b.slug) + '</div>' +
      '<div class="brief-card-meta">' +
        '<span class="badge-type">' + esc(b.page_type) + '</span>' +
        '<span>' + pendingCount + ' pending \u00b7 ' + approvedCount + ' approved</span>' +
        '<span>' + topTV + '</span>' +
      '</div>' +
    '</div>' +
    '<div id="detail-' + esc(b.slug) + '" class="brief-detail" style="display:none">' +
      renderBriefDetail(b) +
    '</div>';
}

function toggleBriefDetail(slug) {
  const el = document.getElementById('detail-' + slug);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function renderBriefDetail(b) {
  const topComp = (b.competitors || []).slice().sort(function(a, z) { return z.traffic_value - a.traffic_value; })[0];
  const pair =
    '<div class="screenshot-pair">' +
      '<div>' +
        '<div class="screenshot-label">Your Page</div>' +
        (b.store_screenshot
          ? '<img src="/screenshot?path=' + encodeURIComponent(b.store_screenshot) + '" class="page-screenshot">'
          : '<div class="screenshot-missing">No screenshot</div>') +
      '</div>' +
      '<div>' +
        '<div class="screenshot-label">Top Competitor' + (topComp ? ' (' + esc(topComp.domain) + ')' : '') + '</div>' +
        (topComp && topComp.screenshot
          ? '<img src="/screenshot?path=' + encodeURIComponent(topComp.screenshot) + '" class="page-screenshot">'
          : '<div class="screenshot-missing">No screenshot</div>') +
      '</div>' +
    '</div>';

  const changes = (b.proposed_changes || []).map(function(c) {
    return '<div class="change-card change-' + esc(c.status) + '">' +
      '<div class="change-header">' +
        '<span class="change-label">' + esc(c.label) + '</span>' +
        '<span class="change-status-pill">' + esc(c.status) + '</span>' +
      '</div>' +
      '<div class="change-diff">' +
        (c.type === 'body_html'
          ? '<iframe srcdoc="' + esc(c.proposed || '') + '" class="html-preview" sandbox=""></iframe>'
          : '<div class="diff-current">' + esc(c.current || '\u2014') + '</div>' +
            '<div class="diff-proposed">' + esc(c.proposed || '') + '</div>') +
      '</div>' +
      '<div class="change-rationale">' + esc(c.rationale || '') + '</div>' +
      (c.status === 'pending'
        ? '<div class="change-actions">' +
            '<button class="btn-approve" onclick="updateChange(&apos;' + esc(b.slug) + '&apos;,&apos;' + esc(c.id) + '&apos;,&apos;approved&apos;)">Approve</button>' +
            '<button class="btn-reject"  onclick="updateChange(&apos;' + esc(b.slug) + '&apos;,&apos;' + esc(c.id) + '&apos;,&apos;rejected&apos;)">Reject</button>' +
          '</div>'
        : '') +
    '</div>';
  }).join('');

  const hasApproved = (b.proposed_changes || []).some(function(c) { return c.status === 'approved'; });
  const applyBtn = hasApproved
    ? '<div class="apply-section">' +
        '<button class="btn-apply" onclick="applyBrief(&apos;' + esc(b.slug) + '&apos;)">Apply Approved Changes</button>' +
        '<pre id="apply-log-' + esc(b.slug) + '" class="run-log" style="display:none"></pre>' +
      '</div>'
    : '';

  return pair + changes + applyBtn;
}

async function updateChange(slug, id, status) {
  await fetch('/brief/' + slug + '/change/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status }),
  });
  loadData(); // re-render with updated brief
}

async function applyBrief(slug) {
  const logEl = document.getElementById('apply-log-' + slug);
  if (logEl) { logEl.style.display = 'block'; logEl.textContent = ''; }
  const res = await fetch('/apply/' + slug, { method: 'POST' });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  function read() {
    reader.read().then(function({ done, value }) {
      if (done) { loadData(); return; }
      for (const line of decoder.decode(value).split('\n')) {
        if (line.startsWith('data: ') && logEl) {
          logEl.textContent += line.slice(6) + '\n';
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      read();
    });
  }
  read();
}

function buildOptimizeKpis(d) {
  const briefs = d.briefs || [];
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const pendingPages = briefs.filter(b =>
    (b.proposed_changes || []).some(c => c.status === 'pending')
  ).length;

  const approvedChanges = briefs
    .flatMap(b => b.proposed_changes || [])
    .filter(c => c.status === 'approved').length;

  const optimizedThisMonth = briefs.filter(b => {
    const changes = b.proposed_changes || [];
    return changes.some(c => c.status === 'applied')
      && !changes.some(c => c.status === 'approved')
      && new Date(b.generated_at) >= monthStart;
  }).length;

  const allTV = briefs.flatMap(b => (b.competitors || []).map(c => (c.traffic_value || 0) / 100));
  const avgTV = allTV.length ? Math.round(allTV.reduce((s, v) => s + v, 0) / allTV.length) : 0;

  return [
    { label: 'Pending Review',        value: pendingPages,          color: '#f59e0b' },
    { label: 'Changes Approved',      value: approvedChanges,       color: '#818cf8' },
    { label: 'Optimized This Month',  value: optimizedThisMonth,    color: '#10b981' },
    { label: 'Avg Traffic Value',     value: '$' + avgTV.toLocaleString(), color: '#38bdf8' },
  ];
}

function buildCreativesKpis() {
  // Pull stats from creativesState (populated by renderCreativesTab)
  var sessions = creativesState.sessions || [];
  var totalImages = sessions.reduce(function(sum, s) { return sum + (s.versionCount || 0); }, 0);
  var totalSessions = sessions.length;
  var templates = creativesState.templates || [];
  // This month
  var now = new Date();
  var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  var thisMonth = sessions.filter(function(s) { return s.updatedAt >= monthStart; });
  var imagesThisMonth = thisMonth.reduce(function(sum, s) { return sum + (s.versionCount || 0); }, 0);
  return [
    { label: 'Total Images',       value: totalImages,        color: '#6c5ce7' },
    { label: 'This Month',         value: imagesThisMonth,    color: '#00b894' },
    { label: 'Sessions',           value: totalSessions,      color: '#818cf8' },
    { label: 'Templates',          value: templates.length,   color: '#f59e0b' },
    { label: 'Models Available',   value: (creativesState.models || []).length, color: '#38bdf8' },
  ];
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}
function badge(cls, text) {
  return '<span class="badge badge-' + cls + '">' + text + '</span>';
}
function statusBadge(s) {
  const map = { published:'published', scheduled:'scheduled', draft:'draft', written:'written', briefed:'briefed', pending:'pending', local:'local' };
  return badge(map[s] || 'pending', s || 'unknown');
}

function renderKanban(d) {
  const cols = [
    { key: 'published', label: 'Published' },
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'draft',     label: 'Draft' },
    { key: 'written',   label: 'Written' },
    { key: 'briefed',   label: 'Briefed' },
    { key: 'pending',   label: 'Pending' },
  ];
  const byStatus = {};
  for (const col of cols) byStatus[col.key] = [];
  for (const item of d.pipeline.items) {
    if (byStatus[item.status]) byStatus[item.status].push(item);
  }

  const html = cols.map(col => {
    const items = byStatus[col.key];
    const itemsHtml = items.map(i => {
      const dateStr = i.publishDate ? fmtDate(i.publishDate) : null;
      const dateLine = dateStr && col.key === 'scheduled' ? '<div class="pub-date-scheduled">' + dateStr + '</div>'
                     : dateStr && col.key === 'published'  ? '<div class="pub-date-published">' + dateStr + '</div>'
                     : '';
      const rejectBtn = (col.key === 'pending' || col.key === 'briefed')
        ? '<button class="kw-reject-btn" onclick="event.stopPropagation();rejectKeyword(this.closest(&quot;.kanban-item&quot;).dataset.keyword,this.closest(&quot;.kanban-item&quot;))">&#10005; Reject</button>'
        : '';
      return '<div class="kanban-item" data-keyword="' + esc(i.keyword) + '"><div class="kw">' + esc(i.keyword) + '</div>' +
        dateLine +
        (i.volume ? '<div class="vol">' + fmtNum(i.volume) + '/mo</div>' : '') +
        rejectBtn + '</div>';
    }).join('');
    return '<div class="kanban-col col-' + col.key + '">' +
      '<div class="kanban-head" onclick="toggleKanbanAccordion(this)">' +
        '<span class="kanban-head-label">' + col.label + '</span>' +
        '<span class="kanban-head-count">' + items.length + '</span>' +
        '<span class="kanban-chevron">&#9660;</span>' +
      '</div>' +
      '<div class="kanban-count">' + items.length + '</div>' +
      (items.length ? '<div class="kanban-items">' + itemsHtml + '</div>' : '') +
      '</div>';
  }).join('');

  document.getElementById('kanban').innerHTML = html;
  document.getElementById('pipeline-note').textContent = d.pipeline.items.length + ' total calendar items';
}

let rankPage    = 0;
let rankSearch  = '';
let rankSort    = { col: null, dir: null };
let rankFilters = { position: 'all', change: 'all', volume: 'all', tier: 'all' };
const RANK_PAGE_SIZE = 10;

function sortRankBy(col) {
  if (rankSort.col === col) {
    if (rankSort.dir === 'asc') { rankSort.dir = 'desc'; }
    else if (rankSort.dir === 'desc') { rankSort.col = null; rankSort.dir = null; }
    else { rankSort.dir = 'asc'; }
  } else {
    rankSort.col = col; rankSort.dir = 'asc';
  }
  rankPage = 0;
  renderRankings(data);
}

function toggleRankMenu(key) {
  const el = document.getElementById('rmenu-' + key);
  if (!el) return;
  const wasOpen = el.classList.contains('open');
  ['position', 'change', 'volume', 'tier'].forEach(function(k) {
    const m = document.getElementById('rmenu-' + k);
    if (m) m.classList.remove('open');
  });
  if (!wasOpen) el.classList.add('open');
}

function setRankFilter(key, val) {
  rankFilters[key] = val;
  rankPage = 0;
  const el = document.getElementById('rmenu-' + key);
  if (el) el.classList.remove('open');
  renderRankings(data);
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.th-filter-wrap')) {
    ['position', 'change', 'volume', 'tier'].forEach(function(k) {
      const m = document.getElementById('rmenu-' + k);
      if (m) m.classList.remove('open');
    });
  }
});

function renderRankings(d) {
  const r = d.rankings;
  if (!r.items.length) {
    document.getElementById('rankings-table').innerHTML = '<div class="empty">No rank snapshots yet. Run <code>npm run rank-tracker</code> to generate one.</div>';
    return;
  }

  const note = r.latestDate ? r.latestDate + (r.previousDate ? ' vs ' + r.previousDate : '') : '';
  document.getElementById('rank-note').textContent = note;

  const tierBadge = function(t) {
    if (t === 'page1')     return badge('page1', 'Page 1');
    if (t === 'quickWins') return badge('quickwins', 'Quick Win');
    if (t === 'needsWork') return badge('needswork-rank', 'Needs Work');
    return badge('notranking', 'Not Ranking');
  };

  const changeHtml = function(x) {
    if (x.change == null) return '<span class="muted">&#8212;</span>';
    if (x.change > 0) return '<span class="change change-up">&#8593; ' + x.change + '</span>';
    if (x.change < 0) return '<span class="change change-down">&#8595; ' + Math.abs(x.change) + '</span>';
    return '<span class="change change-flat">&#8594; 0</span>';
  };

  // ── apply search ──
  const q = rankSearch.toLowerCase();
  let items = q ? r.items.filter(function(x) { return x.keyword.toLowerCase().indexOf(q) !== -1; }) : r.items.slice();

  // ── apply filters ──
  if (rankFilters.position !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.position === 'top3')     return x.position != null && x.position <= 3;
      if (rankFilters.position === 'top10')    return x.position != null && x.position <= 10;
      if (rankFilters.position === 'top20')    return x.position != null && x.position <= 20;
      if (rankFilters.position === 'beyond20') return x.position != null && x.position > 20;
      if (rankFilters.position === 'norank')   return x.position == null;
      return true;
    });
  }
  if (rankFilters.change !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.change === 'improved') return x.change != null && x.change > 0;
      if (rankFilters.change === 'declined') return x.change != null && x.change < 0;
      if (rankFilters.change === 'flat')     return x.change != null && x.change === 0;
      if (rankFilters.change === 'new')      return x.change == null && x.position != null;
      return true;
    });
  }
  if (rankFilters.volume !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.volume === 'high') return (x.volume || 0) >= 1000;
      if (rankFilters.volume === 'med')  return (x.volume || 0) >= 100 && (x.volume || 0) < 1000;
      if (rankFilters.volume === 'low')  return (x.volume || 0) < 100;
      return true;
    });
  }
  if (rankFilters.tier !== 'all') {
    items = items.filter(function(x) { return x.tier === rankFilters.tier; });
  }

  // ── apply sort ──
  if (rankSort.col) {
    const dir = rankSort.dir === 'asc' ? 1 : -1;
    items = items.slice().sort(function(a, b) {
      if (rankSort.col === 'keyword') {
        return dir * a.keyword.localeCompare(b.keyword);
      }
      if (rankSort.col === 'position') {
        if (a.position == null && b.position == null) return 0;
        if (a.position == null) return 1;
        if (b.position == null) return -1;
        return dir * (a.position - b.position);
      }
      if (rankSort.col === 'change') {
        const ac = a.change != null ? a.change : -999;
        const bc = b.change != null ? b.change : -999;
        return dir * (ac - bc);
      }
      if (rankSort.col === 'volume') {
        return dir * ((a.volume || 0) - (b.volume || 0));
      }
      if (rankSort.col === 'tier') {
        const order = { page1: 0, quickWins: 1, needsWork: 2, notRanking: 3 };
        return dir * ((order[a.tier] || 0) - (order[b.tier] || 0));
      }
      return 0;
    });
  }

  // ── paginate ──
  const totalPages = Math.max(1, Math.ceil(items.length / RANK_PAGE_SIZE));
  rankPage = Math.max(0, Math.min(rankPage, totalPages - 1));
  const pageItems = items.slice(rankPage * RANK_PAGE_SIZE, (rankPage + 1) * RANK_PAGE_SIZE);

  // ── active filter chips ──
  const chipLabels = {
    position: { top3: 'Pos: Top 3', top10: 'Pos: Top 10', top20: 'Pos: Top 20', beyond20: 'Pos: 20+', norank: 'Pos: Not ranking' },
    change:   { improved: 'Change: Improved', declined: 'Change: Declined', flat: 'Change: Flat', new: 'Change: New' },
    volume:   { high: 'Vol: High', med: 'Vol: Med', low: 'Vol: Low' },
    tier:     { page1: 'Tier: Page 1', quickWins: 'Tier: Quick Win', needsWork: 'Tier: Needs Work', notRanking: 'Tier: Not Ranking' },
  };
  const chips = Object.keys(rankFilters).filter(function(k) { return rankFilters[k] !== 'all'; }).map(function(k) {
    const label = (chipLabels[k] || {})[rankFilters[k]] || rankFilters[k];
    return '<span class="filter-chip">' + label + '<span class="filter-chip-x" onclick="setRankFilter(&#39;' + k + '&#39;,&#39;all&#39;)">&#215;</span></span>';
  }).join('');
  const chipsHtml = chips ? '<div class="filter-chips">' + chips + '</div>' : '';

  // ── search bar ──
  const searchBar = '<div style="margin-bottom:8px"><input id="rank-search-input" type="text" placeholder="Search keywords..." value="' + esc(rankSearch) + '" oninput="rankSearch=this.value;rankPage=0;renderRankings(data)" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;box-sizing:border-box" /></div>';

  // ── column header builder ──
  function thHtml(label, sortCol, filterKey, filterOpts) {
    const sortInd = rankSort.col === sortCol ? (rankSort.dir === 'asc' ? ' &#8593;' : ' &#8595;') : '';
    const sortAttr = sortCol ? ' class="th-sort" onclick="sortRankBy(&#39;' + sortCol + '&#39;)"' : '';
    let filterHtml = '';
    if (filterKey) {
      const isActive = rankFilters[filterKey] !== 'all';
      const opts = filterOpts.map(function(o) {
        const sel = rankFilters[filterKey] === o.val ? ' selected' : '';
        return '<div class="th-filter-opt' + sel + '" onclick="event.stopPropagation();setRankFilter(&#39;' + filterKey + '&#39;,&#39;' + o.val + '&#39;)">' + o.label + '</div>';
      }).join('');
      filterHtml = '<div class="th-filter-wrap">' +
        '<span class="th-filter-btn' + (isActive ? ' active' : '') + '" onclick="event.stopPropagation();toggleRankMenu(&#39;' + filterKey + '&#39;)">&#9660;</span>' +
        '<div id="rmenu-' + filterKey + '" class="th-filter-menu">' + opts + '</div>' +
        '</div>';
    }
    return '<th><div class="th-inner"><span' + sortAttr + '>' + label + sortInd + '</span>' + filterHtml + '</div></th>';
  }

  const posOpts = [
    { val: 'all', label: 'All' }, { val: 'top3', label: 'Top 3' }, { val: 'top10', label: 'Top 10' },
    { val: 'top20', label: 'Top 20' }, { val: 'beyond20', label: '20+' }, { val: 'norank', label: 'Not ranking' },
  ];
  const chgOpts = [
    { val: 'all', label: 'All' }, { val: 'improved', label: 'Improved' },
    { val: 'declined', label: 'Declined' }, { val: 'flat', label: 'No change' }, { val: 'new', label: 'New entry' },
  ];
  const volOpts = [
    { val: 'all', label: 'All' }, { val: 'high', label: 'High (1k+)' },
    { val: 'med', label: 'Med (100-999)' }, { val: 'low', label: 'Low (<100)' },
  ];
  const tierOpts = [
    { val: 'all', label: 'All' }, { val: 'page1', label: 'Page 1' },
    { val: 'quickWins', label: 'Quick Win' }, { val: 'needsWork', label: 'Needs Work' }, { val: 'notRanking', label: 'Not Ranking' },
  ];

  const rows = pageItems.map(function(x, i) {
    const globalIdx = r.items.indexOf(x);
    const idxRef = globalIdx !== -1 ? globalIdx : rankPage * RANK_PAGE_SIZE + i;
    return '<tr style="cursor:pointer" onclick="openKeywordCard(data.rankings.items[' + idxRef + '])">' +
      '<td>' + esc(x.keyword) + (x.tracked ? ' <span class="muted" style="font-size:10px">&#9679;</span>' : '') + '</td>' +
      '<td class="nowrap"><span class="pos">' + (x.position != null ? '#' + x.position : '&#8212;') + '</span></td>' +
      '<td class="nowrap">' + changeHtml(x) + (x.previousPosition != null ? '<span class="muted" style="font-size:11px;margin-left:4px">was #' + x.previousPosition + '</span>' : '') + '</td>' +
      '<td class="nowrap muted">' + fmtNum(x.volume) + '</td>' +
      '<td>' + tierBadge(x.tier) + '</td>' +
      '</tr>';
  }).join('');

  const pagination =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:13px;">' +
    '<button onclick="rankPage--;renderRankings(data)" ' + (rankPage === 0 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">&#8592; Prev</button>' +
    '<span class="muted">Page ' + (rankPage + 1) + ' of ' + totalPages + ' (' + items.length + ' keywords)</span>' +
    '<button onclick="rankPage++;renderRankings(data)" ' + (rankPage >= totalPages - 1 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">Next &#8594;</button>' +
    '</div>';

  document.getElementById('rankings-table').innerHTML =
    searchBar + chipsHtml +
    '<table><thead><tr>' +
    thHtml('Keyword', 'keyword', null, []) +
    thHtml('Position', 'position', 'position', posOpts) +
    thHtml('Change', 'change', 'change', chgOpts) +
    thHtml('Volume', 'volume', 'volume', volOpts) +
    thHtml('Tier', 'tier', 'tier', tierOpts) +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;
}

let postsPage = 0;
const POSTS_PAGE_SIZE = 10;

function openImageModal(src) {
  closeImageModal();
  const ov = document.createElement('div');
  ov.id = 'img-modal-overlay';
  ov.onclick = closeImageModal;
  const img = document.createElement('img');
  img.src = src;
  img.onclick = function(e) { e.stopPropagation(); };
  ov.appendChild(img);
  document.body.appendChild(ov);
  document.addEventListener('keydown', _imgModalKey);
}
function closeImageModal() {
  const ov = document.getElementById('img-modal-overlay');
  if (ov) ov.remove();
  document.removeEventListener('keydown', _imgModalKey);
}
function _imgModalKey(e) {
  if (e.key === 'Escape') closeImageModal();
}

function renderPosts(d) {
  if (!d.posts.length) {
    document.getElementById('posts-table').innerHTML = '<div class="empty">No posts found.</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(d.posts.length / POSTS_PAGE_SIZE));
  postsPage = Math.max(0, Math.min(postsPage, totalPages - 1));
  document.getElementById('posts-note').textContent = d.posts.length + ' posts';

  const pageItems = d.posts.slice(postsPage * POSTS_PAGE_SIZE, (postsPage + 1) * POSTS_PAGE_SIZE);

  const rows = pageItems.map(function(p) {
    const titleHtml = p.shopifyUrl
      ? '<a class="link" href="' + p.shopifyUrl + '" target="_blank">' + esc(p.title || p.slug) + '</a>'
      : esc(p.title || p.slug);
    const editorHtml = p.editorVerdict === 'Approved'
      ? badge('approved', 'Approved')
      : p.editorVerdict === 'Needs Work'
      ? badge('needswork', '&#9888; Needs Work')
      : '<span class="muted">&#8212;</span>';
    const linksHtml = p.brokenLinks > 0
      ? '<span style="color:var(--red);font-weight:600">' + p.brokenLinks + ' broken</span>'
      : '<span class="muted">&#8212;</span>';
    let imgHtml;
    if (p.hasImage) {
      const imgSrc = p.shopifyImageUrl || ('/images/' + p.slug);
      imgHtml = '<a href="#" onclick="event.preventDefault();openImageModal(&#39;' + esc(imgSrc) + '&#39;)" title="View image" style="font-size:16px;text-decoration:none">&#128444;</a>';
    } else {
      imgHtml = '<span class="muted">&#8212;</span>';
    }
    const dateHtml = p.status === 'scheduled' && p.publishAt
      ? fmtDate(p.publishAt)
      : fmtDate(p.uploadedAt);

    return '<tr>' +
      '<td>' + titleHtml + '</td>' +
      '<td class="muted">' + (p.keyword ? esc(p.keyword) : '&#8212;') + '</td>' +
      '<td>' + statusBadge(p.status) + '</td>' +
      '<td class="nowrap muted">' + dateHtml + '</td>' +
      '<td>' + editorHtml + '</td>' +
      '<td class="nowrap">' + linksHtml + '</td>' +
      '<td style="text-align:center">' + imgHtml + '</td>' +
      '</tr>';
  }).join('');

  const pagination =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:13px;">' +
    '<button onclick="postsPage--;renderPosts(data)" ' + (postsPage === 0 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">&#8592; Prev</button>' +
    '<span class="muted">Page ' + (postsPage + 1) + ' of ' + totalPages + ' (' + d.posts.length + ' posts)</span>' +
    '<button onclick="postsPage++;renderPosts(data)" ' + (postsPage >= totalPages - 1 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">Next &#8594;</button>' +
    '</div>';

  document.getElementById('posts-table').innerHTML =
    '<table><thead><tr>' +
    '<th>Title</th><th>Keyword</th><th>Status</th><th>Date</th><th>Editor</th><th>Links</th><th>Image</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;
}

function renderDataNeeded(d) {
  const items = d.pendingAhrefsData || [];
  const card  = document.getElementById('data-needed-card');
  const body  = document.getElementById('data-needed-body');
  const count = document.getElementById('data-needed-count');

  if (!items.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = '';
  count.textContent = items.length;

  body.innerHTML = items.map(item => {
    const fileChecks = [
      { label: 'SERP Overview',  present: item.hasSerp },
      { label: 'Matching Terms', present: item.hasKeywords },
      { label: 'Volume History', present: item.hasHistory },
    ];
    const fileTags = fileChecks.map(f =>
      '<span class="file-tag ' + (f.present ? 'file-tag-present' : 'file-tag-missing') + '">' +
      (f.present ? '✓ ' : '✗ ') + f.label + '</span>'
    ).join('');

    var statusIcon = (item.hasSerp && item.hasKeywords) ? '&#10003;' : '&#8943;';
    var statusColor = (item.hasSerp && item.hasKeywords) ? 'color:#065f46' : 'color:#7f1d1d';
    return '<details style="border-bottom:1px solid var(--border);padding:6px 0">' +
      '<summary style="list-style:none;display:flex;align-items:center;gap:0.5rem;cursor:pointer;padding:4px 2px">' +
        '<span style="' + statusColor + ';font-size:0.8rem;width:1rem;text-align:center">' + statusIcon + '</span>' +
        '<span style="flex:1;font-weight:500;font-size:0.85rem">' + esc(item.keyword) + '</span>' +
        '<span style="font-size:0.78rem;color:var(--muted);margin-right:0.5rem">Scheduled ' + fmtDate(item.publishDate) + '</span>' +
        '<button id="kw-zip-btn-' + esc(item.slug) + '" class="upload-btn" onclick="event.preventDefault();uploadKeywordZip(' + JSON.stringify(item.slug).replace(/"/g, '&quot;') + ',' + JSON.stringify(item.keyword).replace(/"/g, '&quot;') + ')">&#8593; Upload Zip</button>' +
      '</summary>' +
      '<div style="padding:8px 4px 4px 1.5rem;font-size:0.82rem">' +
        '<div style="color:var(--muted);margin-bottom:4px">' + esc(item.dir) + '</div>' +
        '<div style="margin-bottom:6px">' + fileTags + '</div>' +
        '<div class="data-instructions">' +
          'In Ahrefs Keywords Explorer → search "<strong>' + esc(item.keyword) + '</strong>" →<br>' +
          (!item.hasSerp     ? '&nbsp;• <strong>SERP Overview</strong> tab → Export → save to folder above<br>' : '') +
          (!item.hasKeywords ? '&nbsp;• <strong>Matching Terms</strong> tab → Export (vol ≥100, KD ≤40) → save to folder above<br>' : '') +
          (!item.hasHistory  ? '&nbsp;• <em>Optional:</em> Overview → Volume History chart → Export → save to folder above<br>' : '') +
        '</div>' +
      '</div>' +
    '</details>';
  }).join('');
}

let croFilter = 'today';

function setCroFilter(name, btn) {
  croFilter = name;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (data) renderCROTab(data);
  loadCampaignCards();
}

function aggregateClarity(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const avg = (fn) => { const vals = snaps.map(fn).filter(v => v != null); return vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : null; };
  const sum = (fn) => snaps.reduce((s,x) => s + (fn(x)||0), 0);
  const mergeByName = (fn) => {
    const map = {};
    snaps.forEach(x => (fn(x)||[]).forEach(d => { map[d.name] = (map[d.name]||0) + d.sessions; }));
    return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([name,sessions])=>({name,sessions}));
  };
  const pageMap = {};
  snaps.forEach(x => (x.topPages||[]).forEach(p => { pageMap[p.title] = (pageMap[p.title]||0) + p.sessions; }));
  return {
    date: snaps.length + ' days',
    sessions: { total: sum(x=>x.sessions?.total), bots: sum(x=>x.sessions?.bots), real: sum(x=>x.sessions?.real),
      distinctUsers: sum(x=>x.sessions?.distinctUsers), pagesPerSession: avg(x=>x.sessions?.pagesPerSession) },
    engagement: { totalTime: avg(x=>x.engagement?.totalTime), activeTime: avg(x=>x.engagement?.activeTime) },
    behavior: { scrollDepth: avg(x=>x.behavior?.scrollDepth), rageClickPct: avg(x=>x.behavior?.rageClickPct),
      deadClickPct: avg(x=>x.behavior?.deadClickPct), scriptErrorPct: avg(x=>x.behavior?.scriptErrorPct),
      quickbackPct: avg(x=>x.behavior?.quickbackPct), excessiveScrollPct: avg(x=>x.behavior?.excessiveScrollPct) },
    devices: mergeByName(x=>x.devices),
    countries: mergeByName(x=>x.countries),
    topPages: Object.entries(pageMap).sort((a,b)=>b[1]-a[1]).map(([title,sessions])=>({title,sessions})),
  };
}

function aggregateShopify(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const totalOrders   = snaps.reduce((s,x)=>s+(x.orders?.count||0),0);
  const totalRevenue  = snaps.reduce((s,x)=>s+(x.orders?.revenue||0),0);
  const totalAbandoned = snaps.reduce((s,x)=>s+(x.abandonedCheckouts?.count||0),0);
  const productMap = {};
  snaps.forEach(x => (x.topProducts||[]).forEach(p => {
    if (!productMap[p.title]) productMap[p.title] = {revenue:0,orders:0};
    productMap[p.title].revenue += p.revenue||0;
    productMap[p.title].orders  += p.orders||0;
  }));
  const topProducts = Object.entries(productMap).sort((a,b)=>b[1].revenue-a[1].revenue).slice(0,5).map(([title,v])=>({title,...v}));
  return {
    date: snaps.length + ' days',
    orders: { count: totalOrders, revenue: totalRevenue, aov: totalOrders > 0 ? totalRevenue / totalOrders : 0 },
    abandonedCheckouts: { count: totalAbandoned },
    cartAbandonmentRate: (totalAbandoned + totalOrders) > 0 ? totalAbandoned / (totalAbandoned + totalOrders) : 0,
    topProducts,
  };
}

function aggregateGSC(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const totalClicks      = snaps.reduce((s, x) => s + (x.summary?.clicks || 0), 0);
  const totalImpressions = snaps.reduce((s, x) => s + (x.summary?.impressions || 0), 0);
  const queryMap = {};
  snaps.forEach(x => (x.topQueries || []).forEach(q => {
    if (!queryMap[q.query]) queryMap[q.query] = { clicks: 0, impressions: 0, posWt: 0 };
    queryMap[q.query].clicks      += q.clicks || 0;
    queryMap[q.query].impressions += q.impressions || 0;
    queryMap[q.query].posWt       += (q.position || 0) * (q.impressions || 0);
  }));
  const topQueries = Object.entries(queryMap)
    .sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10)
    .map(([query, v]) => ({
      query, clicks: v.clicks, impressions: v.impressions,
      ctr:      v.impressions > 0 ? Math.round(v.clicks / v.impressions * 10000) / 10000 : 0,
      position: v.impressions > 0 ? Math.round(v.posWt / v.impressions * 10) / 10 : null,
    }));
  const qTotalImpressions = Object.values(queryMap).reduce((s, v) => s + v.impressions, 0);
  const weightedPos = qTotalImpressions > 0
    ? Object.values(queryMap).reduce((s, v) => s + v.posWt, 0) / qTotalImpressions
    : null;
  const pageMap = {};
  snaps.forEach(x => (x.topPages || []).forEach(p => {
    if (!pageMap[p.page]) pageMap[p.page] = { clicks: 0, impressions: 0, posWt: 0 };
    pageMap[p.page].clicks      += p.clicks || 0;
    pageMap[p.page].impressions += p.impressions || 0;
    pageMap[p.page].posWt       += (p.position || 0) * (p.impressions || 0);
  }));
  const topPages = Object.entries(pageMap)
    .sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10)
    .map(([page, v]) => ({
      page, clicks: v.clicks, impressions: v.impressions,
      ctr:      v.impressions > 0 ? Math.round(v.clicks / v.impressions * 10000) / 10000 : 0,
      position: v.impressions > 0 ? Math.round(v.posWt / v.impressions * 10) / 10 : null,
    }));
  return {
    date: snaps.length + ' days',
    summary: { clicks: totalClicks, impressions: totalImpressions,
      ctr: totalImpressions > 0 ? Math.round(totalClicks / totalImpressions * 10000) / 10000 : 0,
      position: weightedPos != null ? Math.round(weightedPos * 10) / 10 : null },
    topQueries, topPages,
  };
}

function aggregateGA4(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const totalSessions    = snaps.reduce((s, x) => s + (x.sessions || 0), 0);
  const totalUsers       = snaps.reduce((s, x) => s + (x.users || 0), 0);
  const totalNewUsers    = snaps.reduce((s, x) => s + (x.newUsers || 0), 0);
  const totalConversions = snaps.reduce((s, x) => s + (x.conversions || 0), 0);
  const totalRevenue     = snaps.reduce((s, x) => s + (x.revenue || 0), 0);
  const active = snaps.filter(x => x.sessions > 0);
  const activeSess = active.reduce((s, x) => s + x.sessions, 0);
  const bounceRate        = activeSess > 0 ? active.reduce((s, x) => s + x.bounceRate * x.sessions, 0) / activeSess : null;
  const avgSessionDuration = activeSess > 0 ? active.reduce((s, x) => s + x.avgSessionDuration * x.sessions, 0) / activeSess : null;
  const sourceMap = {};
  snaps.forEach(x => (x.topSources || []).forEach(s => {
    const k = s.source + '/' + s.medium;
    if (!sourceMap[k]) sourceMap[k] = { source: s.source, medium: s.medium, sessions: 0, conversions: 0, revenue: 0 };
    sourceMap[k].sessions    += s.sessions || 0;
    sourceMap[k].conversions += s.conversions || 0;
    sourceMap[k].revenue     += s.revenue || 0;
  }));
  const topSources = Object.values(sourceMap).sort((a, b) => b.sessions - a.sessions).slice(0, 5);
  const pageMap = {};
  snaps.forEach(x => (x.topLandingPages || []).forEach(p => {
    if (!pageMap[p.page]) pageMap[p.page] = { page: p.page, sessions: 0, conversions: 0, revenue: 0 };
    pageMap[p.page].sessions    += p.sessions || 0;
    pageMap[p.page].conversions += p.conversions || 0;
    pageMap[p.page].revenue     += p.revenue || 0;
  }));
  const topLandingPages = Object.values(pageMap).sort((a, b) => b.sessions - a.sessions).slice(0, 5);
  return {
    date: snaps.length + ' days',
    sessions: totalSessions, users: totalUsers, newUsers: totalNewUsers,
    bounceRate: bounceRate != null ? Math.round(bounceRate * 1000) / 1000 : null,
    avgSessionDuration: avgSessionDuration != null ? Math.round(avgSessionDuration) : null,
    conversions: totalConversions,
    conversionRate: totalSessions > 0 ? Math.round(totalConversions / totalSessions * 1000) / 1000 : 0,
    revenue: Math.round(totalRevenue * 100) / 100,
    topSources, topLandingPages,
  };
}

function renderGSCSEOPanel(data) {
  const gscAll = data.cro?.gscAll || [];
  const gsc  = gscAll[0] || null;
  const pgsc = gscAll[1] || null;

  const fmtPos = v => v != null ? v.toFixed(1) : '—';
  const fmtPct = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const deltaStr = (curr, prev, higherBetter) => {
    if (curr == null || prev == null) return '';
    const d = curr - prev;
    if (Math.abs(d) < 0.001) return '';
    const up = d > 0;
    const good = higherBetter ? up : !up;
    const color = good ? 'var(--green)' : 'var(--red)';
    const sign = up ? '+' : '';
    return ' <span style="font-size:10px;color:' + color + '">' + sign + (Math.abs(d) < 1 ? d.toFixed(2) : Math.round(d)) + '</span>';
  };

  const noteEl = document.getElementById('gsc-seo-note');
  const bodyEl = document.getElementById('gsc-seo-body');
  if (noteEl) noteEl.textContent = gsc ? esc(gsc.date) : '';

  if (!gsc) {
    bodyEl.innerHTML = '<p class="empty-state">No GSC data yet — run gsc-collector to get started.</p>';
    return;
  }

  const s = gsc.summary;
  if (!s) {
    bodyEl.innerHTML = '<p class="empty-state">GSC data is incomplete.</p>';
    return;
  }
  const ps = pgsc?.summary;

  let html = '<div class="gsc-summary">' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtNum(s.clicks) + deltaStr(s.clicks, ps?.clicks, true) + '</span><span class="gsc-stat-label">Clicks</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtNum(s.impressions) + deltaStr(s.impressions, ps?.impressions, true) + '</span><span class="gsc-stat-label">Impressions</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtPct(s.ctr) + deltaStr(s.ctr, ps?.ctr, true) + '</span><span class="gsc-stat-label">CTR</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtPos(s.position) + deltaStr(s.position != null ? -s.position : null, ps?.position != null ? -ps.position : null, true) + '</span><span class="gsc-stat-label">Avg Position</span></div>' +
    '</div>';

  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">';

  html += '<div><div style="font-size:11px;font-weight:600;margin-bottom:8px">Top Queries</div>' +
    '<table class="gsc-table"><thead><tr><th>Query</th><th>Clicks</th><th>Impr</th><th>CTR</th><th>Pos</th></tr></thead><tbody>' +
    (gsc.topQueries || []).map(q =>
      '<tr><td>' + esc((q.query || '').length > 40 ? (q.query || '').slice(0,40) + '...' : (q.query || '')) + '</td>' +
      '<td>' + esc(String(q.clicks)) + '</td><td>' + esc(String(q.impressions)) + '</td>' +
      '<td>' + fmtPct(q.ctr) + '</td><td>' + fmtPos(q.position) + '</td></tr>'
    ).join('') +
    '</tbody></table></div>';

  html += '<div><div style="font-size:11px;font-weight:600;margin-bottom:8px">Top Pages</div>' +
    '<table class="gsc-table"><thead><tr><th>Page</th><th>Clicks</th><th>Impr</th><th>CTR</th><th>Pos</th></tr></thead><tbody>' +
    (gsc.topPages || []).map(p => {
      const slug = p.page.replace(/^https?:\/\/[^/]+/, '').slice(0, 35) || '/';
      return '<tr><td title="' + esc(p.page) + '">' + esc(slug) + '</td>' +
        '<td>' + esc(String(p.clicks)) + '</td><td>' + esc(String(p.impressions)) + '</td>' +
        '<td>' + fmtPct(p.ctr) + '</td><td>' + fmtPos(p.position) + '</td></tr>';
    }).join('') +
    '</tbody></table></div>';

  html += '</div>';
  bodyEl.innerHTML = html;
}

var briefItemContents = [];

function prioColor(p) { return p === 'HIGH' ? '#dc2626' : p === 'MED' ? '#d97706' : '#6b7280'; }

function openBriefModal(idx) {
  var item = briefItemContents[idx];
  if (!item) return;
  var bodyText = item.body.join('\n');
  var bodyHtml = esc(bodyText).replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>');
  var sections = bodyHtml.split('\n');
  var out = '';
  var inPre = false;
  for (var si = 0; si < sections.length; si++) {
    var sl = sections[si];
    var isTableRow = sl.trim().charAt(0) === '|';
    if (isTableRow && !inPre) { out += '<pre style="font-size:12px;line-height:1.5;overflow-x:auto;background:#f9fafb;border-radius:6px;padding:10px 12px;margin:8px 0">'; inPre = true; }
    if (!isTableRow && inPre) { out += '</pre>'; inPre = false; }
    if (isTableRow) {
      out += sl + '\n';
    } else if (sl.trim()) {
      out += '<p style="margin:6px 0;font-size:13px;line-height:1.6">' + sl + '</p>';
    }
  }
  if (inPre) out += '</pre>';
  var prioLabel = item.priority ? '<span style="font-size:11px;font-weight:700;color:' + prioColor(item.priority) + ';text-transform:uppercase;letter-spacing:.06em;margin-right:8px">' + item.priority + '</span>' : '';
  document.getElementById('brief-modal-content').innerHTML =
    '<div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #e5e7eb">' + prioLabel +
    '<span style="font-size:16px;font-weight:700;color:#1f2937">' + esc(item.title) + '</span></div>' +
    out;
  document.getElementById('brief-modal-overlay').style.display = 'flex';
}

function closeBriefModal(e) {
  if (e && e.target !== document.getElementById('brief-modal-overlay')) return;
  document.getElementById('brief-modal-overlay').style.display = 'none';
}

function runDeepDive(category, handle, itemTitle) {
    var agentMap = {
      'content-formatting': 'agents/cro-deep-dive-content/index.js',
      'seo-discovery':      'agents/cro-deep-dive-seo/index.js',
      'trust-conversion':   'agents/cro-deep-dive-trust/index.js',
    };
    var agent = agentMap[category];
    if (!agent) return;
    runAgent(agent, ['--handle', handle, '--item', itemTitle]);
  }

function renderCROTab(data) {
  const cro = data.cro || {};
  const clarityAll = cro.clarityAll || [];
  const shopifyAll = cro.shopifyAll || [];

  const gscAll = cro.gscAll || [];
  const ga4All = cro.ga4All || [];

  let cl, sh, ga4, gsc, pcl, psh, pga4, pgsc, dateLabel;
  if (croFilter === 'yesterday') {
    cl = clarityAll[1] || null; pcl = clarityAll[2] || null;
    sh = shopifyAll[1] || null; psh = shopifyAll[2] || null;
    ga4 = ga4All[1] || null;   pga4 = ga4All[2] || null;
    gsc = gscAll[1] || null;   pgsc = gscAll[2] || null;
    dateLabel = 'Yesterday';
  } else if (croFilter === '7days') {
    cl  = aggregateClarity(clarityAll.slice(0,7));   pcl  = aggregateClarity(clarityAll.slice(7,14));
    sh  = aggregateShopify(shopifyAll.slice(0,7));   psh  = aggregateShopify(shopifyAll.slice(7,14));
    ga4 = aggregateGA4(ga4All.slice(0,7));           pga4 = aggregateGA4(ga4All.slice(7,14));
    gsc = aggregateGSC(gscAll.slice(0,7));           pgsc = aggregateGSC(gscAll.slice(7,14));
    dateLabel = 'Last 7 Days';
  } else if (croFilter === '30days') {
    cl  = aggregateClarity(clarityAll.slice(0,30));  pcl  = aggregateClarity(clarityAll.slice(30,60));
    sh  = aggregateShopify(shopifyAll.slice(0,30));  psh  = aggregateShopify(shopifyAll.slice(30,60));
    ga4 = aggregateGA4(ga4All.slice(0,30));          pga4 = aggregateGA4(ga4All.slice(30,60));
    gsc = aggregateGSC(gscAll.slice(0,30));          pgsc = aggregateGSC(gscAll.slice(30,60));
    dateLabel = 'Last 30 Days';
  } else {
    cl = clarityAll[0] || null; pcl = clarityAll[1] || null;
    sh = shopifyAll[0] || null; psh = shopifyAll[1] || null;
    ga4 = ga4All[0] || null;   pga4 = ga4All[1] || null;
    gsc = gscAll[0] || null;   pgsc = gscAll[1] || null;
    dateLabel = 'Today';
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  const fmtPct = v => v != null ? v.toFixed(1) + '%' : '—';
  const fmtDollar = v => v != null ? '$' + Math.round(v).toLocaleString() : '—';
  const delta = (curr, prev, higherIsBetter = true) => {
    if (curr == null || prev == null) return '<span class="kpi-delta flat">—</span>';
    const diff = curr - prev;
    const dir = diff > 0 ? (higherIsBetter ? 'up' : 'down') : diff < 0 ? (higherIsBetter ? 'down' : 'up') : 'flat';
    const sign = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    const display = Math.abs(diff) < 1 ? Math.abs(diff).toFixed(2) : Math.round(Math.abs(diff));
    return '<span class="kpi-delta ' + dir + '">' + sign + ' ' + display + '</span>';
  };

  // ── KPI strip ──────────────────────────────────────────────────────────────
  const kpis = [
    { label: 'Conversion Rate', value: ga4 ? fmtPct(ga4.conversionRate * 100) : '—',
      d: delta(ga4?.conversionRate != null ? ga4.conversionRate * 100 : null,
               pga4?.conversionRate != null ? pga4.conversionRate * 100 : null), alert: false },
    { label: 'Bounce Rate',     value: ga4 ? fmtPct(ga4.bounceRate * 100) : '—',
      d: delta(ga4?.bounceRate != null ? ga4.bounceRate * 100 : null,
               pga4?.bounceRate != null ? pga4.bounceRate * 100 : null, false), alert: false },
    { label: 'Avg Order Value', value: sh ? fmtDollar(sh.orders.aov) : '—',
      d: delta(sh?.orders?.aov, psh?.orders?.aov), alert: false },
    { label: 'Real Sessions',   value: cl ? cl.sessions.real : '—',
      sub: cl ? 'of ' + cl.sessions.total + ' total' : '',
      d: delta(cl?.sessions?.real, pcl?.sessions?.real), alert: false },
    { label: 'Script Errors',   value: cl ? fmtPct(cl.behavior.scriptErrorPct) : '—',
      d: delta(cl?.behavior?.scriptErrorPct, pcl?.behavior?.scriptErrorPct, false),
      alert: cl?.behavior?.scriptErrorPct > 5 },
    { label: 'Scroll Depth',    value: cl ? fmtPct(cl.behavior.scrollDepth) : '—',
      d: delta(cl?.behavior?.scrollDepth, pcl?.behavior?.scrollDepth), alert: false },
    { label: 'Cart Abandon',    value: sh ? fmtPct(sh.cartAbandonmentRate * 100) : '—',
      d: delta(sh?.cartAbandonmentRate != null ? sh.cartAbandonmentRate * 100 : null,
               psh?.cartAbandonmentRate != null ? psh.cartAbandonmentRate * 100 : null, false), alert: false },
  ];

  document.getElementById('cro-kpi-strip').innerHTML =
    '<div class="kpi-strip">' +
    kpis.map(k =>
      '<div class="kpi-card' + (k.alert ? ' alert' : '') + '">' +
      '<div class="kpi-value">' + k.value + '</div>' +
      '<div class="kpi-label">' + k.label + '</div>' +
      (k.sub ? '<div class="cro-sub">' + k.sub + '</div>' : '') +
      k.d +
      '</div>'
    ).join('') +
    '</div>';

  // ── Clarity card ───────────────────────────────────────────────────────────
  const clarityHtml = cl ? (
    '<div class="card">' +
    '<div class="card-header accent-purple"><h2>Clarity</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Total Sessions</td><td>' + cl.sessions.total + ' <span class="cro-sub">(' + cl.sessions.bots + ' bots)</span></td></tr>' +
    '<tr><td>Active Engagement</td><td>' + parseFloat(cl.engagement.activeTime).toFixed(1) + 's <span class="cro-sub">of ' + parseFloat(cl.engagement.totalTime).toFixed(1) + 's</span></td></tr>' +
    '<tr><td>Device Split</td><td>' + (cl.devices[0] ? esc(cl.devices[0].name) + ': ' + cl.devices[0].sessions : '—') + '</td></tr>' +
    '<tr><td>Top Country</td><td>' + (cl.countries[0] ? esc(cl.countries[0].name) + ' (' + cl.countries[0].sessions + ')' : '—') + '</td></tr>' +
    '<tr><td>Rage Clicks</td><td>' + fmtPct(cl.behavior.rageClickPct) + '</td></tr>' +
    '<tr><td>Dead Clicks</td><td>' + fmtPct(cl.behavior.deadClickPct) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Pages</div>' +
    (cl.topPages || []).slice(0, 5).map((p, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(p.title.length > 50 ? p.title.slice(0,50)+'…' : p.title) + ' — ' + p.sessions + '</div>'
    ).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No Clarity data collected yet — run clarity-collector to get started.</p></div></div>';

  document.getElementById('cro-clarity-card').innerHTML = clarityHtml;

  // ── Shopify card ───────────────────────────────────────────────────────────
  const shopifyHtml = sh ? (
    '<div class="card">' +
    '<div class="card-header accent-green"><h2>Shopify</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Revenue</td><td>' + fmtDollar(sh.orders.revenue) + '</td></tr>' +
    '<tr><td>Orders</td><td>' + sh.orders.count + '</td></tr>' +
    '<tr><td>Avg Order Value</td><td>' + fmtDollar(sh.orders.aov) + '</td></tr>' +
    '<tr><td>Abandoned Carts</td><td>' + sh.abandonedCheckouts.count + '</td></tr>' +
    '<tr><td>Cart Abandon Rate</td><td>' + fmtPct(sh.cartAbandonmentRate * 100) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Products</div>' +
    ((sh.topProducts || []).length ? (sh.topProducts || []).slice(0, 5).map((p, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(p.title) + ' — ' + fmtDollar(p.revenue) + ' (' + p.orders + ' orders)</div>'
    ).join('') : '<div style="font-size:11px;color:var(--muted)">No orders today</div>') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No Shopify data collected yet — run shopify-collector to get started.</p></div></div>';

  document.getElementById('cro-shopify-card').innerHTML = shopifyHtml;

  // ── GA4 card ────────────────────────────────────────────────────────────────
  const ga4Html = ga4 ? (
    '<div class="card">' +
    '<div class="card-header accent-orange"><h2>GA4</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Sessions</td><td>' + fmtNum(ga4.sessions) + '</td></tr>' +
    '<tr><td>Users</td><td>' + fmtNum(ga4.users) + ' <span class="cro-sub">(' + fmtNum(ga4.newUsers) + ' new)</span></td></tr>' +
    '<tr><td>Bounce Rate</td><td>' + (ga4.bounceRate != null ? fmtPct(ga4.bounceRate * 100) : '—') + '</td></tr>' +
    '<tr><td>Avg Session</td><td>' + (ga4.avgSessionDuration != null ? Math.round(ga4.avgSessionDuration) + 's' : '—') + '</td></tr>' +
    '<tr><td>Conversions</td><td>' + fmtNum(ga4.conversions) + ' <span class="cro-sub">(' + fmtPct(ga4.conversionRate * 100) + ')</span></td></tr>' +
    '<tr><td>Revenue</td><td>' + fmtDollar(ga4.revenue) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Sources</div>' +
    (ga4.topSources || []).map((s, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + esc(String(i+1)) + '. ' + esc(s.source) + ' / ' + esc(s.medium) + ' — ' + fmtNum(s.sessions) + ' sessions</div>'
    ).join('') +
    '<div style="margin-top:10px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Landing Pages</div>' +
    (ga4.topLandingPages || []).map((p, i) => {
      const slug = (p.page || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 40) || '/';
      return '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + esc(String(i+1)) + '. ' + esc(slug) + ' — ' + fmtDollar(p.revenue) + '</div>';
    }).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No GA4 data yet — run ga4-collector to get started.</p></div></div>';

  document.getElementById('cro-ga4-card').innerHTML = ga4Html;

  // ── GSC card (CRO tab) ──────────────────────────────────────────────────────
  const gscCROHtml = gsc ? (
    '<div class="card">' +
    '<div class="card-header accent-sky"><h2>Search Console</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Clicks</td><td>' + esc(String(gsc.summary?.clicks ?? '—')) + '</td></tr>' +
    '<tr><td>Impressions</td><td>' + esc(String(gsc.summary?.impressions ?? '—')) + '</td></tr>' +
    '<tr><td>CTR</td><td>' + (gsc.summary?.ctr != null ? (gsc.summary.ctr * 100).toFixed(1) + '%' : '—') + '</td></tr>' +
    '<tr><td>Avg Position</td><td>' + (gsc.summary?.position != null ? gsc.summary.position.toFixed(1) : '—') + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Queries</div>' +
    (gsc.topQueries || []).slice(0, 5).map((q, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + esc(String(i+1)) + '. ' + esc((q.query || '').length > 40 ? (q.query || '').slice(0,40) + '...' : (q.query || '')) + ' — ' + esc(String(q.clicks)) + ' clicks</div>'
    ).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No GSC data yet — run gsc-collector to get started.</p></div></div>';

  document.getElementById('cro-gsc-card').innerHTML = gscCROHtml;

  // ── CRO Brief ──────────────────────────────────────────────────────────────
  const brief = cro.brief;
  let briefHtml;
  if (!brief) {
    briefHtml = '<div class="card"><div class="card-body"><p class="empty-state">No brief generated yet — run cro-analyzer to generate your first brief.</p></div></div>';
  } else {
    // Parse action items from markdown (lines starting with ### N.)
    var items = [];
    var lines = brief.content.split('\n');
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^### [ ]*[0-9]+\./.test(line)) {
        if (current) items.push(current);
        // Extract category and page handle from HTML comment
        var catMatch = line.match(/<!--[ ]*category:(\S+)[ ]+page:(\S+)[ ]*-->/);
        var category = catMatch ? catMatch[1] : null;
        var pageHandle = catMatch ? catMatch[2] : null;
        // Strip comment, then strip priority suffix, then strip "### N. " prefix
        var cleanLine = line
          .replace(/<!--.*?-->/g, '')
          .replace(/[ ]*[—\-][ ]*(HIGH|MED|LOW)[ ]*$/i, '')
          .replace(/^### [ ]*[0-9]+\.[ ]*/, '')
          .trim();
        // Extract priority from original line
        var prioMatch = line.match(/[—\-][ ]*(HIGH|MED|LOW)/i);
        var priority = prioMatch ? prioMatch[1].toUpperCase() : '';
        current = { title: cleanLine, priority: priority, category: category, pageHandle: pageHandle, body: [] };
      } else if (current && line.trim() && !/^##/.test(line)) {
        current.body.push(line.trim());
      }
    }
    if (current) items.push(current);

    // Store items globally so openBriefModal can access full body content
    briefItemContents = items;

    briefHtml = '<div class="card">' +
      '<div class="card-header accent-amber"><h2>AI CRO Brief</h2>' +
      '<span class="section-note">Generated ' + esc(brief.date) + ' · Next run: Every Monday</span></div>' +
      '<div class="card-body">' +
      (items.length ? '<div class="brief-grid">' +
        items.map(function(item, idx) {
          var actions;
          if (item.category && item.pageHandle) {
            var safeTitle = esc(item.title);
            actions = '<div class="brief-item-actions">' +
              '<button class="btn-cro-resolve" onclick="event.stopPropagation();runDeepDive(' + "'" + esc(item.category) + "'" + ', ' + "'" + esc(item.pageHandle) + "'" + ', ' + "'" + safeTitle + "')" + '">' +
              'Deep Dive</button>' +
              '</div>';
          } else {
            actions = '<div class="brief-item-actions"><span class="badge-manual">Manual</span></div>';
          }
          return '<div class="brief-item" onclick="openBriefModal(' + idx + ')" style="cursor:pointer" title="Click to expand">' +
            '<div class="brief-item-title" style="color:' + prioColor(item.priority) + '">' +
            (item.priority ? item.priority + ' — ' : '') + esc(item.title) + '</div>' +
            actions +
            '</div>';
        }).join('') + '</div>'
      : '<pre style="font-size:11px;white-space:pre-wrap">' + esc(brief.content) + '</pre>') +
      '</div></div>';
  }

  document.getElementById('cro-brief-card').innerHTML = briefHtml;
}

function renderRankAlertBanner(alert) {
  const el = document.getElementById('rank-alert-banner');
  if (!el) return;
  if (!alert) { el.style.display = 'none'; return; }
  const isNeg = alert.drops > alert.gains;
  el.className = 'alert-banner ' + (isNeg ? 'alert-red' : 'alert-green');
  el.style.display = '';
  el.innerHTML =
    (isNeg ? '🔻' : '🚀') + ' ' +
    '<strong>' + (isNeg ? alert.drops + ' rank drops' : alert.gains + ' rank gains') + ' today</strong> — ' +
    esc(alert.file.replace('.md', '')) +
    '<span class="alert-banner-dismiss" onclick="dismissAlert()">Dismiss ×</span>';
}

async function dismissAlert() {
  await fetch('/dismiss-alert', { method: 'POST' });
  document.getElementById('rank-alert-banner').style.display = 'none';
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function mdToHtml(md) {
  if (!md) return '';
  var s = md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  var lines = s.split('\n');
  var out = [];
  var inList = false;
  for (var li = 0; li < lines.length; li++) {
    var ln = lines[li];
    ln = ln.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
    ln = ln.replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
    ln = ln.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
    var stripped = ln.replace(/^[ ]*/,'');
    if (stripped.indexOf('### ') === 0) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div class="chat-md-h3">' + stripped.slice(4) + '</div>');
    } else if (stripped.indexOf('## ') === 0) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div class="chat-md-h2">' + stripped.slice(3) + '</div>');
    } else if (stripped.indexOf('# ') === 0) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div class="chat-md-h2">' + stripped.slice(2) + '</div>');
    } else if (stripped.indexOf('- ') === 0 || stripped.indexOf('* ') === 0) {
      if (!inList) { out.push('<ul class="chat-md-ul">'); inList = true; }
      out.push('<li>' + stripped.slice(2) + '</li>');
    } else if (stripped === '') {
      if (inList) { out.push('</ul>'); inList = false; }
      if (out.length && out[out.length - 1] !== '<div class="chat-md-gap"></div>') {
        out.push('<div class="chat-md-gap"></div>');
      }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div>' + ln + '</div>');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function kpiCard(label, value, sub) {
  return '<div class="kpi-card">' +
    '<div class="kpi-value">' + esc(String(value)) + '</div>' +
    '<div class="kpi-label">' + esc(label) + '</div>' +
    (sub ? '<div class="cro-sub">' + esc(sub) + '</div>' : '') +
    '</div>';
}

async function renderAdIntelligenceTab() {
  const el = document.getElementById('ad-intelligence-content');
  el.innerHTML = '<p class="muted" style="padding:2rem">Loading\u2026</p>';
  try {
    const res = await fetch('/api/meta-ads-insights', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ads || data.ads.length === 0) {
      el.innerHTML = '<p class="muted" style="padding:2rem">No ad intelligence data yet. Run the meta-ads-collector and meta-ads-analyzer agents first.</p>';
      return;
    }
    const ads = data.ads.slice(0, 12);
    el.innerHTML =
      '<div style="padding:1.5rem">' +
      '<h2 style="margin:0 0 0.25rem">Ad Intelligence</h2>' +
      '<p class="muted" style="margin:0 0 1.5rem">Competitor ads from Meta Ads Library \u00b7 Last updated ' + esc(data.date || 'unknown') + '</p>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1.25rem">' +
      ads.map(function(ad) { return renderAdCard(ad); }).join('') +
      '</div></div>';
  } catch (e) {
    el.innerHTML = '<p class="muted" style="padding:2rem">Error loading data: ' + esc(e.message) + '</p>';
  }
}

// ── Creatives tab state ─────────────────────────────────────────────────────
var creativesState = {
  sessionId: null,
  currentVersion: null,
  aspectRatio: '1:1',
  referenceImages: [],
  models: [],
  templates: [],
  sessions: [],
  compareMode: false,
  compareVersions: []
};

async function renderCreativesTab() {
  try {
    var [modelsRes, templatesRes, sessionsRes] = await Promise.all([
      fetch('/api/creatives/models', { credentials: 'same-origin' }),
      fetch('/api/creatives/templates', { credentials: 'same-origin' }),
      fetch('/api/creatives/sessions', { credentials: 'same-origin' })
    ]);
    creativesState.models = await modelsRes.json();
    creativesState.templates = await templatesRes.json();
    creativesState.sessions = await sessionsRes.json();
    renderCreativesModels();
    updateResolutionOptions();
    renderCreativesTemplates();
    renderCreativesSessions();
    // Update hero KPIs for creatives tab
    renderHeroKpis(data || {});
    // Load most recent session
    if (creativesState.sessions.length > 0) {
      var latest = creativesState.sessions[0];
      document.getElementById('creatives-session-select').value = latest.id;
      await loadCreativesSession(latest.id);
    }
  } catch (e) {
    console.error('renderCreativesTab error', e);
  }
}

function renderCreativesModels() {
  var sel = document.getElementById('creatives-model-select');
  if (!sel) return;
  sel.innerHTML = creativesState.models.map(function(m) {
    return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>';
  }).join('');
  if (creativesState.models.length > 0) sel.value = creativesState.models[0].id;
}

function renderCreativesTemplates() {
  var sel = document.getElementById('creatives-template-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">None</option>' +
    creativesState.templates.map(function(t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
    }).join('');
}

function renderCreativesSessions() {
  var sel = document.getElementById('creatives-session-select');
  if (!sel) return;
  if (creativesState.sessions.length === 0) {
    sel.innerHTML = '<option value="">No sessions</option>';
    return;
  }
  sel.innerHTML = creativesState.sessions.map(function(s) {
    var label = s.name || ('Session ' + s.id.slice(-6));
    return '<option value="' + esc(s.id) + '">' + esc(label) + '</option>';
  }).join('');
}

async function loadCreativesSession(sessionId) {
  if (!sessionId) return;
  try {
    var res = await fetch('/api/creatives/sessions/' + encodeURIComponent(sessionId), { credentials: 'same-origin' });
    var session = await res.json();
    creativesState.sessionId = session.id;
    creativesState.referenceImages = session.referenceImages || [];
    creativesState.aspectRatio = session.aspectRatio || '1:1';
    // Populate form
    var promptEl = document.getElementById('creatives-prompt');
    var negEl = document.getElementById('creatives-negative-prompt');
    if (promptEl) promptEl.value = session.prompt || '';
    if (negEl) negEl.value = session.negativePrompt || '';
    // Set session name
    var nameEl = document.getElementById('creatives-session-name');
    if (nameEl) nameEl.textContent = session.name || '';
    // Set model
    var modelSel = document.getElementById('creatives-model-select');
    if (modelSel && session.model) modelSel.value = session.model;
    // Set template
    var tplSel = document.getElementById('creatives-template-select');
    if (tplSel) tplSel.value = session.templateId || '';
    // Set aspect ratio buttons
    setAspectRatio(creativesState.aspectRatio, null);
    // Render ref images
    renderCreativesRefImages();
    // Render filmstrip
    renderCreativesFilmstrip(session.versions || []);
    // Show latest image
    if (session.versions && session.versions.length > 0) {
      var favorites = session.versions.filter(function(v) { return v.favorite; });
      var latest = favorites.length > 0 ? favorites[0] : session.versions[session.versions.length - 1];
      creativesState.currentVersion = latest.version || latest.versionNumber || 1;
      showCreativeImage(latest.imagePath, latest);
    } else {
      hideCreativeImage();
    }
  } catch (e) {
    console.error('loadCreativesSession error', e);
  }
}

function onCreativesSessionChange() {
  var sel = document.getElementById('creatives-session-select');
  if (sel && sel.value) loadCreativesSession(sel.value);
}

function onCreativesModelChange() {
  updateRefCount();
  updateResolutionOptions();
}

function updateResolutionOptions() {
  var model = getSelectedModel();
  var resSel = document.getElementById('creatives-resolution-select');
  if (!resSel || !model) return;
  var resolutions = model.resolutions || ['1K'];
  var current = resSel.value;
  resSel.innerHTML = resolutions.map(function(r) {
    return '<option value="' + r + '"' + (r === current ? ' selected' : '') + '>' + r + '</option>';
  }).join('');
  // If current selection not available in new model, default to highest available
  if (resolutions.indexOf(current) === -1) {
    resSel.value = resolutions[resolutions.length - 1];
  }
}

function onCreativesTemplateChange() {
  var sel = document.getElementById('creatives-template-select');
  if (!sel || !sel.value) return;
  var t = creativesState.templates.find(function(tpl) { return tpl.id === sel.value; });
  if (!t) return;
  if (t.prompt) {
    var promptEl = document.getElementById('creatives-prompt');
    if (promptEl) promptEl.value = t.prompt;
  }
  if (t.negativePrompt) {
    var negEl = document.getElementById('creatives-negative-prompt');
    if (negEl) negEl.value = t.negativePrompt;
  }
  if (t.defaultAspectRatio) {
    setAspectRatio(t.defaultAspectRatio, null);
  }
  if (t.defaultModel) {
    var modelSel = document.getElementById('creatives-model-select');
    if (modelSel) {
      modelSel.value = t.defaultModel;
      onCreativesModelChange();
    }
  }
}

function setAspectRatio(ar, btn) {
  creativesState.aspectRatio = ar;
  // Update button classes
  var btns = document.querySelectorAll('.ar-btn');
  btns.forEach(function(b) { b.classList.remove('active'); });
  if (btn) {
    btn.classList.add('active');
  } else {
    // Find by text content
    btns.forEach(function(b) {
      if (b.textContent.trim() === ar) b.classList.add('active');
    });
  }
  // Show/hide custom inputs
  var customInputs = document.getElementById('ar-custom-inputs');
  if (customInputs) {
    customInputs.style.display = ar === 'custom' ? 'flex' : 'none';
  }
}

function renderCreativesRefImages() {
  var area = document.getElementById('ref-images-area');
  var placeholder = document.getElementById('ref-images-placeholder');
  if (!area) return;
  if (creativesState.referenceImages.length === 0) {
    if (placeholder) placeholder.style.display = '';
    // Remove any thumbnails
    var thumbs = area.querySelectorAll('.ref-thumb');
    thumbs.forEach(function(t) { t.remove(); });
    return;
  }
  if (placeholder) placeholder.style.display = 'none';
  // Remove old thumbs
  var thumbs = area.querySelectorAll('.ref-thumb');
  thumbs.forEach(function(t) { t.remove(); });
  creativesState.referenceImages.forEach(function(img, i) {
    var div = document.createElement('div');
    div.className = 'ref-thumb';
    var borderColor = img.type === 'product' ? '#a78bfa' : img.type === 'history' ? '#f59e0b' : '#34d399';
    div.style.cssText = 'position:relative;width:60px;height:60px;border-radius:6px;overflow:hidden;border:2px solid ' + borderColor + ';flex-shrink:0';
    var imgEl = document.createElement('img');
    var imgSrc = img.url || img.path || '';
    if (img.type === 'product') imgSrc = '/api/creatives/product-image/' + img.path;
    else if (img.type === 'history') imgSrc = '/api/creatives/image/' + img.path;
    imgEl.src = imgSrc;
    imgEl.style.cssText = 'width:100%;height:100%;object-fit:cover';
    var rm = document.createElement('button');
    rm.innerHTML = '&times;';
    rm.style.cssText = 'position:absolute;top:0;right:0;background:rgba(0,0,0,0.6);color:white;border:none;width:18px;height:18px;font-size:12px;line-height:1;cursor:pointer;border-radius:0 0 0 4px;padding:0';
    rm.onclick = (function(idx) { return function() { removeRefImage(idx); }; })(i);
    div.appendChild(imgEl);
    div.appendChild(rm);
    // For uploaded refs not yet saved to library, add a Save button
    if (img.file) {
      var saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save';
      saveBtn.title = 'Save to reference library';
      saveBtn.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.65);color:white;border:none;font-size:10px;line-height:1.4;cursor:pointer;padding:2px 0;text-align:center';
      saveBtn.onclick = (function(idx) { return function(e) { e.stopPropagation(); saveRefToLibrary(idx); }; })(i);
      div.appendChild(saveBtn);
    }
    area.appendChild(div);
  });
  updateRefCount();
}

function updateRefCount() {
  var countEl = document.getElementById('ref-image-count');
  if (!countEl) return;
  var model = getSelectedModel();
  var maxRef = model ? model.maxReferenceImages : 10;
  var cnt = creativesState.referenceImages.length;
  countEl.textContent = '(' + cnt + '/' + maxRef + ')';
}

function getSelectedModel() {
  var sel = document.getElementById('creatives-model-select');
  if (!sel) return null;
  return creativesState.models.find(function(m) { return m.id === sel.value; }) || null;
}

function checkRefImageLimit() {
  var model = getSelectedModel();
  var max = model ? model.maxReferenceImages : 10;
  return creativesState.referenceImages.length < max;
}

function removeRefImage(index) {
  creativesState.referenceImages.splice(index, 1);
  renderCreativesRefImages();
}

function showCreativeImage(imagePath, version) {
  creativesState.currentVersion = (typeof version === 'object' && version !== null) ? (version.version || version.versionNumber || 1) : version;
  creativesState.currentImagePath = imagePath;
  var img = document.getElementById('creatives-current-img');
  var placeholder = document.getElementById('creatives-img-placeholder');
  var actionBtns = document.getElementById('creatives-action-btns');
  var packageWrap = document.getElementById('creatives-package-wrap');
  if (img) {
    img.src = '/api/creatives/image/' + imagePath;
    img.style.display = 'block';
  }
  if (placeholder) placeholder.style.display = 'none';
  if (actionBtns) actionBtns.style.display = 'flex';
  if (packageWrap) packageWrap.style.display = 'block';
}

function hideCreativeImage() {
  creativesState.currentVersion = null;
  var img = document.getElementById('creatives-current-img');
  var placeholder = document.getElementById('creatives-img-placeholder');
  var actionBtns = document.getElementById('creatives-action-btns');
  var packageWrap = document.getElementById('creatives-package-wrap');
  if (img) { img.src = ''; img.style.display = 'none'; }
  if (placeholder) placeholder.style.display = '';
  if (actionBtns) actionBtns.style.display = 'none';
  if (packageWrap) packageWrap.style.display = 'none';
}

function renderCreativesFilmstrip(versions) {
  var strip = document.getElementById('creatives-filmstrip');
  if (!strip) return;
  if (!versions || versions.length === 0) {
    strip.innerHTML = '<span style="font-size:0.78rem;color:var(--muted)">No versions yet</span>';
    return;
  }
  // Favorites (gold border) first
  var favs = versions.filter(function(v) { return v.favorite; });
  var rest = versions.filter(function(v) { return !v.favorite; });
  var ordered = favs.concat(rest).slice().reverse(); // most recent first within each group
  strip.innerHTML = ordered.map(function(v, i) {
    var border = v.favorite ? '2px solid #f59e0b' : '2px solid var(--border)';
    var star = v.favorite ? '\u2605' : '\u2606';
    var starColor = v.favorite ? '#f59e0b' : '#d1d5db';
    var isCurrent = creativesState.currentVersion && creativesState.currentVersion.id === v.id;
    var outline = isCurrent ? 'outline:2px solid #6c5ce7;outline-offset:2px' : '';
    return '<div class="filmstrip-thumb" style="position:relative;flex-shrink:0;cursor:pointer;' + outline + '" onclick="selectFilmstripVersion(' + JSON.stringify(v).replace(/"/g,'&quot;') + ')" title="v' + (v.versionNumber || (i+1)) + '">' +
      '<img src="/api/creatives/image/' + esc(v.imagePath) + '" style="width:70px;height:70px;object-fit:cover;border-radius:6px;border:' + border + '" onerror="this.style.background=&apos;#f3f4f6&apos;">' +
      '<button onclick="event.stopPropagation();toggleFavorite(' + JSON.stringify(v).replace(/"/g,'&quot;') + ')" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.5);border:none;color:' + starColor + ';font-size:12px;width:18px;height:18px;border-radius:3px;cursor:pointer;padding:0;line-height:1">' + star + '</button>' +
      '<button class="filmstrip-delete" onclick="event.stopPropagation();deleteVersion(' + JSON.stringify(v).replace(/"/g,'&quot;') + ')" style="position:absolute;bottom:2px;right:2px;background:rgba(220,38,38,0.85);border:none;color:white;font-size:10px;width:18px;height:18px;border-radius:3px;cursor:pointer;padding:0;line-height:1;display:none">&#128465;</button>' +
      '<button class="filmstrip-ref" onclick="event.stopPropagation();useHistoryAsReference(&apos;' + esc(v.imagePath) + '&apos;)" style="position:absolute;bottom:2px;left:2px;background:rgba(108,92,231,0.85);border:none;color:white;font-size:8px;width:18px;height:18px;border-radius:3px;cursor:pointer;padding:0;line-height:1;display:none" title="Use as reference">&#128206;</button>' +
      '</div>';
  }).join('');
}

function selectFilmstripVersion(version) {
  if (creativesState.compareMode) {
    // In compare mode: collect versions; render when 2 are selected
    var alreadyIdx = creativesState.compareVersions.findIndex(function(v) { return v.imagePath === version.imagePath; });
    if (alreadyIdx !== -1) {
      // Deselect if already selected
      creativesState.compareVersions.splice(alreadyIdx, 1);
    } else {
      creativesState.compareVersions.push(version);
      if (creativesState.compareVersions.length > 2) {
        creativesState.compareVersions.shift();
      }
    }
    if (creativesState.compareVersions.length === 2) {
      var compareWrap = document.getElementById('creatives-compare-wrap');
      if (compareWrap) compareWrap.style.display = 'flex';
      renderCompareView();
    }
    return;
  }
  showCreativeImage(version.imagePath, version);
  // Re-render filmstrip to update outline
  if (creativesState.sessionId) {
    fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(s) { renderCreativesFilmstrip(s.versions || []); })
      .catch(function() {});
  }
}

async function toggleFavorite(version) {
  if (!creativesState.sessionId) return;
  try {
    await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ toggleFavorite: version.id })
    });
    var res = await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), { credentials: 'same-origin' });
    var session = await res.json();
    renderCreativesFilmstrip(session.versions || []);
  } catch (e) {
    console.error('toggleFavorite error', e);
  }
}

async function deleteVersion(version) {
  if (!creativesState.sessionId) return;
  if (!confirm('Delete this version?')) return;
  try {
    await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ deleteVersion: version.version || version.versionNumber })
    });
    var res = await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), { credentials: 'same-origin' });
    var session = await res.json();
    renderCreativesFilmstrip(session.versions || []);
    // If we deleted the current version, show the latest remaining
    var currentVer = creativesState.currentVersion;
    var stillExists = (session.versions || []).some(function(v) { return v.version === currentVer; });
    if (!stillExists && session.versions && session.versions.length > 0) {
      var latest = session.versions[session.versions.length - 1];
      showCreativeImage(latest.imagePath, latest.version);
    } else if (!session.versions || session.versions.length === 0) {
      hideCreativeImage();
    }
  } catch (e) {
    console.error('deleteVersion error', e);
  }
}

// ── Task 15: Generate, refine, upload, download, package ────────────────────

async function generateCreativeImage() {
  if (!creativesState.sessionId) {
    // Create a new session first
    try {
      var newRes = await fetch('/api/creatives/sessions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      var newSession = await newRes.json();
      creativesState.sessionId = newSession.id;
      creativesState.sessions.unshift(newSession);
      renderCreativesSessions();
      var sel = document.getElementById('creatives-session-select');
      if (sel) sel.value = newSession.id;
    } catch (e) {
      showCreativesError('Could not create session: ' + e.message);
      return;
    }
  }
  var prompt = (document.getElementById('creatives-prompt') || {}).value || '';
  if (!prompt.trim()) { showCreativesError('Please enter a prompt.'); return; }
  var negativePrompt = (document.getElementById('creatives-negative-prompt') || {}).value || '';
  var model = document.getElementById('creatives-model-select');
  var modelId = model ? model.value : '';
  var ar = creativesState.aspectRatio;
  var formData = new FormData();
  formData.append('sessionId', creativesState.sessionId);
  var resSel = document.getElementById('creatives-resolution-select');
  var resolution = resSel ? resSel.value : '1K';
  formData.append('prompt', prompt);
  formData.append('negativePrompt', negativePrompt);
  formData.append('model', modelId);
  formData.append('aspectRatio', ar);
  formData.append('imageSize', resolution);
  if (ar === 'custom') {
    var cw = (document.getElementById('ar-custom-w') || {}).value || '';
    var ch = (document.getElementById('ar-custom-h') || {}).value || '';
    formData.append('customWidth', cw);
    formData.append('customHeight', ch);
  }
  // Reference images: separate product paths vs uploaded files
  var productPaths = [];
  var uploadFiles = [];
  var historyPaths = [];
  creativesState.referenceImages.forEach(function(img) {
    if (img.type === 'product' && img.path) {
      productPaths.push(img.path);
    } else if (img.type === 'history' && img.path) {
      historyPaths.push(img.path);
    } else if (img.file) {
      uploadFiles.push(img.file);
    }
  });
  if (productPaths.length > 0) { formData.append('productImagePaths', JSON.stringify(productPaths)); }
  if (historyPaths.length > 0) { formData.append('historyImagePaths', JSON.stringify(historyPaths)); }
  uploadFiles.forEach(function(f) { formData.append('referenceImages', f); });
  showCreativesSpinner('Generating...');
  try {
    var res = await fetch('/api/creatives/generate', { method: 'POST', credentials: 'same-origin', body: formData });
    var data = await res.json();
    hideCreativesSpinner();
    if (data.error) { showCreativesError(data.error); return; }
    creativesState.sessionId = data.sessionId;
    creativesState.currentVersion = data.version;
    showCreativeImage(data.imagePath, data.version);
    // Update session name if it was auto-generated
    if (data.sessionName) {
      var sessionObj = creativesState.sessions.find(function(s) { return s.id === data.sessionId; });
      if (sessionObj) sessionObj.name = data.sessionName;
      renderCreativesSessions();
    }
    // Refresh filmstrip
    var sRes = await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), { credentials: 'same-origin' });
    var session = await sRes.json();
    renderCreativesFilmstrip(session.versions || []);
    showAutosaveIndicator();
  } catch (e) {
    hideCreativesSpinner();
    showCreativesError('Generate failed: ' + e.message);
  }
}

async function refineCreativeImage() {
  if (!creativesState.sessionId || !creativesState.currentVersion) {
    showCreativesError('No image to refine. Generate an image first.');
    return;
  }
  var refinement = (document.getElementById('creatives-refine-prompt') || {}).value || '';
  if (!refinement.trim()) { showCreativesError('Please enter a refinement instruction.'); return; }
  var refineModel = document.getElementById('creatives-model-select');
  var refineModelId = refineModel ? refineModel.value : '';
  showCreativesSpinner('Refining...');
  try {
    var res = await fetch('/api/creatives/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        sessionId: creativesState.sessionId,
        version: creativesState.currentVersion,
        refinement: refinement,
        model: refineModelId
      })
    });
    var data = await res.json();
    hideCreativesSpinner();
    if (data.error) { showCreativesError(data.error); return; }
    creativesState.currentVersion = data.version;
    showCreativeImage(data.imagePath, data.version);
    var sRes = await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), { credentials: 'same-origin' });
    var session = await sRes.json();
    renderCreativesFilmstrip(session.versions || []);
    var refEl = document.getElementById('creatives-refine-prompt');
    if (refEl) refEl.value = '';
    showAutosaveIndicator();
  } catch (e) {
    hideCreativesSpinner();
    showCreativesError('Refine failed: ' + e.message);
  }
}

function openProductImagePicker() {
  openProductImageModal();
}

function openReferenceUpload() {
  var input = document.getElementById('ref-image-input');
  if (input) input.click();
}

function handleReferenceUpload(input) {
  if (!input.files || !input.files.length) return;
  if (!checkRefImageLimit()) {
    var model = getSelectedModel();
    var max = model ? model.maxReferenceImages : 10;
    showCreativesError('Maximum ' + max + ' reference images allowed for this model.');
    return;
  }
  for (var i = 0; i < input.files.length; i++) {
    if (!checkRefImageLimit()) break;
    var f = input.files[i];
    creativesState.referenceImages.push({ type: 'upload', file: f, url: URL.createObjectURL(f), name: f.name });
  }
  renderCreativesRefImages();
  input.value = '';
}

function handleRefImageDrop(event) {
  event.preventDefault();
  var files = event.dataTransfer.files;
  if (!files || !files.length) return;
  for (var i = 0; i < files.length; i++) {
    if (!checkRefImageLimit()) break;
    var f = files[i];
    if (!f.type.startsWith('image/')) continue;
    creativesState.referenceImages.push({ type: 'upload', file: f, url: URL.createObjectURL(f), name: f.name });
  }
  renderCreativesRefImages();
}

function downloadCreativeImage() {
  if (!creativesState.currentImagePath) return;
  window.open('/api/creatives/image/' + creativesState.currentImagePath + '?download=1', '_blank');
}

async function packageCreative() {
  if (!creativesState.sessionId || !creativesState.currentVersion) return;
  var btn = document.getElementById('creatives-package-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Packaging...'; }
  try {
    var res = await fetch('/api/creatives/package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ sessionId: creativesState.sessionId, version: creativesState.currentVersion })
    });
    var data = await res.json();
    if (!data.ok) { resetPackageBtn(); showCreativesError(data.error || 'Package failed'); return; }
    pollCreativePackage(data.jobId);
  } catch (e) {
    resetPackageBtn();
    showCreativesError('Package failed: ' + e.message);
  }
}

function pollCreativePackage(jobId) {
  fetch('/api/creatives/package/' + encodeURIComponent(jobId), { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status === 'done') {
        resetPackageBtn();
        window.open('/api/creatives/package/download/' + encodeURIComponent(jobId), '_blank');
      } else if (data.status === 'error') {
        resetPackageBtn();
        showCreativesError(data.error || 'Package failed');
      } else {
        setTimeout(function() { pollCreativePackage(jobId); }, 3000);
      }
    })
    .catch(function(e) { resetPackageBtn(); showCreativesError('Polling failed: ' + e.message); });
}

function resetPackageBtn() {
  var btn = document.getElementById('creatives-package-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = '&#128230; Package for All Placements'; }
}

function showCreativesSpinner(text) {
  var spinner = document.getElementById('creatives-spinner');
  var spinnerText = document.getElementById('creatives-spinner-text');
  if (spinner) spinner.style.display = 'flex';
  if (spinnerText) spinnerText.textContent = text || 'Working...';
}

function hideCreativesSpinner() {
  var spinner = document.getElementById('creatives-spinner');
  if (spinner) spinner.style.display = 'none';
}

function showCreativesError(msg) {
  var errEl = document.getElementById('creatives-error');
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.style.display = 'block';
  setTimeout(function() { errEl.style.display = 'none'; }, 6000);
}

function showAutosaveIndicator() {
  var el = document.getElementById('creatives-autosave');
  if (!el) return;
  el.style.opacity = '1';
  setTimeout(function() { el.style.opacity = '0'; }, 2000);
}

async function editSessionName() {
  var current = (document.getElementById('creatives-session-name') || {}).textContent || '';
  var newName = prompt('Rename session:', current);
  if (!newName || !newName.trim() || !creativesState.sessionId) return;
  try {
    await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name: newName.trim() })
    });
    var nameEl = document.getElementById('creatives-session-name');
    if (nameEl) nameEl.textContent = newName.trim();
    // Update sessions list
    var session = creativesState.sessions.find(function(s) { return s.id === creativesState.sessionId; });
    if (session) session.name = newName.trim();
    renderCreativesSessions();
    var sel = document.getElementById('creatives-session-select');
    if (sel) sel.value = creativesState.sessionId;
    showAutosaveIndicator();
  } catch (e) {
    showCreativesError('Rename failed: ' + e.message);
  }
}

function openImageLightbox(src) {
  var modal = document.getElementById('image-lightbox');
  var img = document.getElementById('lightbox-img');
  if (modal && img) { img.src = src; modal.style.display = 'flex'; }
}

function closeImageLightbox() {
  var modal = document.getElementById('image-lightbox');
  if (modal) modal.style.display = 'none';
}

function toggleUpscaleMenu() {
  var menu = document.getElementById('upscale-menu');
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

async function upscaleImage(targetRes) {
  var menu = document.getElementById('upscale-menu');
  if (menu) menu.style.display = 'none';
  if (!creativesState.sessionId || !creativesState.currentVersion) return;

  // Fetch the current version's prompt data from the session
  showCreativesSpinner('Regenerating at ' + targetRes + '...');
  try {
    var sRes = await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), { credentials: 'same-origin' });
    var session = await sRes.json();
    var ver = (session.versions || []).find(function(v) { return v.version === creativesState.currentVersion; });
    if (!ver) { showCreativesError('Version not found'); hideCreativesSpinner(); return; }

    // Rebuild the generation request with same prompt + original image as reference + higher resolution
    var formData = new FormData();
    formData.append('prompt', 'Reproduce this exact image at higher resolution. Keep everything identical — same composition, products, branding, colors, lighting, and layout. ' + (ver.prompt || ''));
    formData.append('negativePrompt', ver.negativePrompt || '');
    formData.append('model', ver.model || session.model || creativesState.models[0].id);
    formData.append('aspectRatio', ver.aspectRatio || session.aspectRatio || '1:1');
    formData.append('imageSize', targetRes);
    formData.append('sessionId', creativesState.sessionId);

    // Send the current image as a history reference so Gemini can see it
    formData.append('historyImagePaths', JSON.stringify([ver.imagePath]));

    // Also include original product image references
    var productPaths = (session.referenceImages || []).filter(function(r) { return r.type === 'product'; }).map(function(r) { return r.path; });
    if (productPaths.length > 0) formData.append('productImagePaths', JSON.stringify(productPaths));

    var res = await fetch('/api/creatives/generate', { method: 'POST', credentials: 'same-origin', body: formData });
    var data = await res.json();
    hideCreativesSpinner();
    if (data.error) { showCreativesError(data.error); return; }
    showCreativeImage(data.imagePath, data.version);

    // Refresh filmstrip
    var sRes2 = await fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), { credentials: 'same-origin' });
    var session2 = await sRes2.json();
    renderCreativesFilmstrip(session2.versions || []);
  } catch (e) {
    hideCreativesSpinner();
    showCreativesError('Upscale failed: ' + e.message);
  }
}

function useHistoryAsReference(imagePath) {
  // Check if already added
  if (creativesState.referenceImages.some(function(r) { return r.path === imagePath; })) return;
  // Check model limit
  var model = getSelectedModel();
  var max = model ? model.maxReferenceImages : 16;
  if (creativesState.referenceImages.length >= max) {
    showCreativesError('Maximum reference images reached for this model (' + max + ')');
    return;
  }
  creativesState.referenceImages.push({ type: 'history', path: imagePath });
  renderCreativesRefImages();
  updateProductContext();
}

function clearCreativesForm() {
  var promptEl = document.getElementById('creatives-prompt');
  var negEl = document.getElementById('creatives-negative-prompt');
  if (promptEl) promptEl.value = '';
  if (negEl) negEl.value = '';
  creativesState.referenceImages = [];
  renderCreativesRefImages();
  updateProductContext();
  var templateSel = document.getElementById('creatives-template-select');
  if (templateSel) templateSel.value = '';
  setAspectRatio('1:1', document.querySelector('.ar-btn[data-ar="1:1"]'));
}

async function createNewCreativesSession() {
  try {
    var res = await fetch('/api/creatives/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({})
    });
    var session = await res.json();
    creativesState.sessions.unshift(session);
    renderCreativesSessions();
    var sel = document.getElementById('creatives-session-select');
    if (sel) sel.value = session.id;
    await loadCreativesSession(session.id);
  } catch (e) {
    showCreativesError('Could not create session: ' + e.message);
  }
}

function updateProductContext() {
  var ctx = document.getElementById('creatives-product-context');
  if (!ctx) return;
  var productRefs = creativesState.referenceImages.filter(function(img) { return img.type === 'product'; });
  if (productRefs.length < 2) {
    ctx.style.display = 'none';
    return;
  }
  ctx.style.display = 'block';
  var body = document.getElementById('product-context-body');
  if (!body) return;
  body.innerHTML = '<p style="color:var(--muted);font-size:0.78rem;margin:0">Loading product descriptions...</p>';
  // Fetch product descriptions from manifest
  fetch('/api/creatives/product-images', { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var products = Array.isArray(data) ? data : [];
      body.innerHTML = productRefs.map(function(ref, i) {
        var product = products.find(function(p) { return p.handle === ref.handle; });
        var title = product ? (product.title || product.handle) : (ref.handle || 'Product');
        var desc = product && product.productDescription ? product.productDescription : 'No description available. Add one in manifest.json.';
        return '<div style="padding:0.5rem 0;border-bottom:1px solid var(--border)">' +
          '<div style="font-size:0.8rem;font-weight:600;color:var(--fg);margin-bottom:0.25rem">' + (i + 1) + '. ' + esc(title) + '</div>' +
          '<textarea style="width:100%;font-size:0.78rem;border:1px solid var(--border);border-radius:4px;padding:0.4rem;resize:vertical;box-sizing:border-box;font-family:inherit;background:var(--surface);color:var(--fg)" rows="2" data-product-idx="' + i + '">' + esc(desc) + '</textarea>' +
          '</div>';
      }).join('');
    })
    .catch(function(e) { body.innerHTML = '<p style="color:#ef4444;font-size:0.78rem;margin:0">Failed to load: ' + esc(e.message) + '</p>'; });
}

function toggleProductContext() {
  // No-op — product context is always visible when 2+ products selected
}

// ── Task 16: Compare mode ───────────────────────────────────────────────────

function toggleCompareMode() {
  creativesState.compareMode = !creativesState.compareMode;
  var btn = document.getElementById('compare-btn');
  if (creativesState.compareMode) {
    if (btn) { btn.style.background = '#6c5ce7'; btn.style.color = 'white'; }
    creativesState.compareVersions = [];
    // Open lightbox and render filmstrip inside it
    var modal = document.getElementById('compare-lightbox');
    if (modal) {
      modal.style.display = 'flex';
      document.getElementById('compare-lightbox-body').innerHTML = '<div style="color:rgba(255,255,255,0.5);font-size:1rem;padding:3rem;text-align:center">Select two versions below to compare</div>';
      renderCompareFilmstrip();
    }
  } else {
    exitCompareMode();
  }
}

function renderCompareView() {
  var body = document.getElementById('compare-lightbox-body');
  if (!body) return;
  var versions = creativesState.compareVersions;
  if (!versions || versions.length < 2) return;
  var makePanel = function(v) {
    var label = v.favorite ? '\\u2605 Version ' + (v.version || '?') : 'Version ' + (v.version || '?');
    var promptText = v.refinement ? 'Refinement: ' + v.refinement : (v.prompt ? v.prompt.slice(0, 120) + '...' : '');
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:0.75rem;min-width:0;max-width:50%">' +
      '<div style="font-size:0.9rem;font-weight:600;color:white">' + label + '</div>' +
      '<img src="/api/creatives/image/' + esc(v.imagePath) + '" style="max-width:100%;max-height:65vh;border-radius:8px;object-fit:contain">' +
      '<div style="font-size:0.75rem;color:rgba(255,255,255,0.5);text-align:center;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(promptText) + '</div>' +
      '<button onclick="useCompareVersion(' + JSON.stringify(v).replace(/"/g,'&quot;') + ')" style="padding:0.4rem 1rem;background:#6c5ce7;color:white;border:none;border-radius:6px;font-size:0.82rem;cursor:pointer;font-weight:600">Use This Version</button>' +
      '</div>';
  };
  body.innerHTML = '<div style="display:flex;gap:2rem;align-items:flex-start;justify-content:center;width:100%;max-width:95vw;padding:1rem">' +
    makePanel(versions[0]) +
    '<div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;flex-shrink:0"></div>' +
    makePanel(versions[1]) +
    '</div>';
}

function exitCompareMode() {
  creativesState.compareMode = false;
  creativesState.compareVersions = [];
  var btn = document.getElementById('compare-btn');
  if (btn) { btn.style.background = ''; btn.style.color = ''; }
  var modal = document.getElementById('compare-lightbox');
  if (modal) { modal.style.display = 'none'; }
}

function useCompareVersion(version) {
  exitCompareMode();
  showCreativeImage(version.imagePath, version);
}

function renderCompareFilmstrip() {
  var strip = document.getElementById('compare-filmstrip');
  if (!strip || !creativesState.sessionId) return;
  fetch('/api/creatives/sessions/' + encodeURIComponent(creativesState.sessionId), { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(session) {
      var versions = session.versions || [];
      strip.innerHTML = versions.map(function(v) {
        var isSelected = creativesState.compareVersions.some(function(cv) { return cv.version === v.version; });
        var border = isSelected ? '3px solid #6c5ce7' : '2px solid rgba(255,255,255,0.2)';
        return '<div onclick="selectCompareVersion(' + JSON.stringify(v).replace(/"/g,'&quot;') + ')" style="flex-shrink:0;cursor:pointer;border-radius:6px;overflow:hidden;border:' + border + '">' +
          '<img src="/api/creatives/image/' + esc(v.imagePath) + '" style="width:70px;height:70px;object-fit:cover;display:block">' +
          '</div>';
      }).join('');
    });
}

function selectCompareVersion(version) {
  var idx = creativesState.compareVersions.findIndex(function(v) { return v.version === version.version; });
  if (idx !== -1) {
    creativesState.compareVersions.splice(idx, 1);
  } else {
    creativesState.compareVersions.push(version);
    if (creativesState.compareVersions.length > 2) creativesState.compareVersions.shift();
  }
  renderCompareFilmstrip();
  if (creativesState.compareVersions.length === 2) {
    renderCompareView();
  } else {
    document.getElementById('compare-lightbox-body').innerHTML = '<div style="color:rgba(255,255,255,0.5);font-size:1rem;padding:3rem;text-align:center">Select ' + (2 - creativesState.compareVersions.length) + ' more version' + (creativesState.compareVersions.length === 1 ? '' : 's') + '</div>';
  }
}

// ── Task 17: Product image picker modal ─────────────────────────────────────

async function openProductImageModal() {
  var modal = document.getElementById('product-image-modal');
  if (!modal) return;
  var grid = document.getElementById('product-image-grid');
  if (grid) grid.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">Loading...</p>';
  modal.style.display = 'flex';
  try {
    var res = await fetch('/api/creatives/product-images', { credentials: 'same-origin' });
    var data = await res.json();
    if (!grid) return;
    var products = Array.isArray(data) ? data : (data.products || []);
    if (products.length === 0) {
      grid.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No product images found.</p>';
      return;
    }
    grid.style.display = 'block';
    grid.innerHTML = products.filter(function(p) { return p.images && p.images.length > 0; }).map(function(p) {
      var imgDir = p.imageDir || p.handle || '';
      return '<div style="margin-bottom:1rem">' +
        '<div style="font-size:0.82rem;font-weight:600;color:#374151;margin-bottom:0.5rem;padding-bottom:0.25rem;border-bottom:1px solid #e5e7eb">' + esc(p.title || p.handle) + '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        (p.images || []).map(function(imgFile) {
          var imgPath = imgDir + '/' + imgFile;
          var selected = creativesState.referenceImages.some(function(r) { return r.path === imgPath; });
          var border = selected ? '3px solid #6c5ce7' : '1px solid #e5e7eb';
          return '<div onclick="selectProductImage(&apos;' + esc(p.handle) + '&apos;,&apos;' + esc(imgPath) + '&apos;,this)" style="cursor:pointer;border-radius:6px;overflow:hidden;border:' + border + ';width:100px;height:100px;flex-shrink:0" data-selected="' + selected + '">' +
            '<img src="/api/creatives/product-image/' + esc(imgPath) + '" style="width:100%;height:100%;object-fit:contain;display:block;background:#fafafa" onerror="this.style.background=&apos;#f3f4f6&apos;">' +
            '</div>';
        }).join('') +
        '</div></div>';
    }).join('');
  } catch (e) {
    if (grid) grid.innerHTML = '<p style="color:#ef4444;font-size:0.85rem">Error: ' + esc(e.message) + '</p>';
  }
}

function selectProductImage(handle, imgPath, el) {
  var alreadyIdx = creativesState.referenceImages.findIndex(function(r) { return r.path === imgPath; });
  if (alreadyIdx !== -1) {
    creativesState.referenceImages.splice(alreadyIdx, 1);
    if (el) { el.style.border = '2px solid var(--border)'; el.dataset.selected = 'false'; }
  } else {
    if (!checkRefImageLimit()) {
      var model = getSelectedModel();
      showCreativesError('Maximum ' + (model ? model.maxReferenceImages : 10) + ' reference images allowed.');
      return;
    }
    creativesState.referenceImages.push({ type: 'product', path: imgPath, url: '/api/creatives/product-image/' + imgPath, handle: handle });
    if (el) { el.style.border = '3px solid #6c5ce7'; el.dataset.selected = 'true'; }
  }
  updateRefCount();
  updateProductContext();
}

function closeProductImageModal() {
  var modal = document.getElementById('product-image-modal');
  if (modal) modal.style.display = 'none';
  renderCreativesRefImages();
}

// ── Task 18: Template management modal ─────────────────────────────────────

function openManageTemplates() {
  var modal = document.getElementById('template-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  renderTemplateList();
}

function closeTemplateModal() {
  var modal = document.getElementById('template-modal');
  if (modal) modal.style.display = 'none';
}

function renderTemplateList() {
  var list = document.getElementById('template-modal-list');
  if (!list) return;
  if (creativesState.templates.length === 0) {
    list.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;text-align:center;padding:1rem">No templates yet. Create one below.</p>';
    return;
  }
  list.innerHTML = creativesState.templates.map(function(t) {
    return '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 0.75rem;border:1px solid var(--border);border-radius:7px;background:var(--bg)">' +
      (t.previewImage ? '<img src="/api/creatives/template-preview/' + esc(t.previewImage) + '" style="width:48px;height:48px;object-fit:cover;border-radius:5px;border:1px solid var(--border)">' : '<div style="width:48px;height:48px;background:var(--card);border-radius:5px;border:1px solid var(--border)"></div>') +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.name) + '</div>' +
        (t.prompt ? '<div style="font-size:0.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.prompt.slice(0, 60)) + '</div>' : '') +
      '</div>' +
      '<button onclick="editTemplate(&apos;' + esc(t.id) + '&apos;)" style="padding:0.25rem 0.6rem;border:1px solid var(--border);border-radius:5px;font-size:0.78rem;cursor:pointer;background:var(--surface)">Edit</button>' +
      '<button onclick="deleteTemplate(&apos;' + esc(t.id) + '&apos;)" style="padding:0.25rem 0.6rem;border:1px solid #fca5a5;border-radius:5px;font-size:0.78rem;cursor:pointer;background:#fff5f5;color:#dc2626">Delete</button>' +
      '</div>';
  }).join('');
}

async function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  try {
    await fetch('/api/creatives/templates/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
    creativesState.templates = creativesState.templates.filter(function(t) { return t.id !== id; });
    renderTemplateList();
    renderCreativesTemplates();
  } catch (e) {
    showCreativesError('Delete failed: ' + e.message);
  }
}

function editTemplate(id) {
  var tpl = creativesState.templates.find(function(t) { return t.id === id; });
  if (tpl) openTemplateForm(tpl);
}

function openNewTemplateForm() {
  openTemplateForm(null);
}

function openTemplateForm(existing) {
  var formWrap = document.getElementById('template-form-wrap');
  if (!formWrap) return;
  formWrap.style.display = 'block';
  var nameInput = document.getElementById('template-form-name');
  var promptInput = document.getElementById('template-form-prompt');
  var negativePromptInput = document.getElementById('template-form-negative-prompt');
  var tagsInput = document.getElementById('template-form-tags');
  var aspectRatioInput = document.getElementById('template-form-aspect-ratio');
  var modelInput = document.getElementById('template-form-model');
  var idInput = document.getElementById('template-form-id');
  if (nameInput) nameInput.value = existing ? (existing.name || '') : '';
  if (promptInput) promptInput.value = existing ? (existing.prompt || '') : '';
  if (negativePromptInput) negativePromptInput.value = existing ? (existing.negativePrompt || '') : '';
  if (tagsInput) tagsInput.value = existing && existing.tags ? existing.tags.join(', ') : '';
  if (aspectRatioInput) aspectRatioInput.value = existing ? (existing.defaultAspectRatio || '1:1') : '1:1';
  if (idInput) idInput.value = existing ? (existing.id || '') : '';
  var title = document.getElementById('template-form-title');
  if (title) title.textContent = existing ? 'Edit Template' : 'New Template';
  // Populate model select from creativesState.models
  if (modelInput && creativesState.models) {
    var prevModelVal = modelInput.value;
    modelInput.innerHTML = '<option value="">-- same as current --</option>';
    creativesState.models.forEach(function(m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      modelInput.appendChild(opt);
    });
    modelInput.value = existing ? (existing.defaultModel || '') : prevModelVal;
  }
}

async function saveTemplateForm(existingId, isEdit) {
  var nameInput = document.getElementById('template-form-name');
  var promptInput = document.getElementById('template-form-prompt');
  var negativePromptInput = document.getElementById('template-form-negative-prompt');
  var tagsInput = document.getElementById('template-form-tags');
  var aspectRatioInput = document.getElementById('template-form-aspect-ratio');
  var modelInput = document.getElementById('template-form-model');
  var name = nameInput ? nameInput.value.trim() : '';
  var prompt = promptInput ? promptInput.value.trim() : '';
  var negativePrompt = negativePromptInput ? negativePromptInput.value.trim() : '';
  var tagsRaw = tagsInput ? tagsInput.value.trim() : '';
  var tags = tagsRaw ? tagsRaw.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : [];
  var defaultAspectRatio = aspectRatioInput ? aspectRatioInput.value : '1:1';
  var defaultModel = modelInput ? modelInput.value : '';
  if (!name) { showCreativesError('Template name is required.'); return; }
  var id = isEdit ? existingId : name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  try {
    var url = isEdit ? '/api/creatives/templates/' + encodeURIComponent(existingId) : '/api/creatives/templates';
    var method = isEdit ? 'PUT' : 'POST';
    var res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: id, name: name, prompt: prompt, negativePrompt: negativePrompt, tags: tags, defaultAspectRatio: defaultAspectRatio, defaultModel: defaultModel })
    });
    var saved = await res.json();
    if (isEdit) {
      var idx = creativesState.templates.findIndex(function(t) { return t.id === existingId; });
      if (idx !== -1) creativesState.templates[idx] = saved;
    } else {
      creativesState.templates.push(saved);
    }
    renderTemplateList();
    renderCreativesTemplates();
    var formWrap = document.getElementById('template-form-wrap');
    if (formWrap) formWrap.style.display = 'none';
  } catch (e) {
    showCreativesError('Save failed: ' + e.message);
  }
}

function openCreateFromImage() {
  var wrap = document.getElementById('template-from-image-wrap');
  if (wrap) wrap.style.display = 'block';
}

function previewFromImage(input) {
  if (!input.files || !input.files.length) return;
  var f = input.files[0];
  var preview = document.getElementById('template-from-image-preview');
  if (preview) {
    preview.src = URL.createObjectURL(f);
    preview.style.display = 'block';
  }
}

async function analyzeTemplateImage() {
  var input = document.getElementById('template-from-image-input');
  if (!input || !input.files || !input.files.length) {
    showCreativesError('Please select an image first.');
    return;
  }
  var formData = new FormData();
  formData.append('image', input.files[0]);
  try {
    var res = await fetch('/api/creatives/templates/from-image', { method: 'POST', credentials: 'same-origin', body: formData });
    var data = await res.json();
    if (!data.ok) { showCreativesError(data.error || 'Analysis failed'); return; }
    var promptEl = document.getElementById('template-from-image-result');
    if (promptEl) promptEl.value = data.prompt || '';
    var saveWrap = document.getElementById('template-from-image-save-wrap');
    if (saveWrap) saveWrap.style.display = 'block';
    // Store preview path for saving
    creativesState._fromImagePreviewPath = data.previewPath || '';
  } catch (e) {
    showCreativesError('Analysis failed: ' + e.message);
  }
}

async function saveAiTemplate(previewPath) {
  var promptEl = document.getElementById('template-from-image-result');
  var nameInput = document.getElementById('template-from-image-name');
  var prompt = promptEl ? promptEl.value.trim() : '';
  var name = nameInput ? nameInput.value.trim() : '';
  if (!name) { showCreativesError('Template name is required.'); return; }
  try {
    var res = await fetch('/api/creatives/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name: name, prompt: prompt, previewImage: previewPath || creativesState._fromImagePreviewPath || '' })
    });
    var saved = await res.json();
    creativesState.templates.push(saved);
    renderTemplateList();
    renderCreativesTemplates();
    var wrap = document.getElementById('template-from-image-wrap');
    if (wrap) wrap.style.display = 'none';
  } catch (e) {
    showCreativesError('Save failed: ' + e.message);
  }
}

function saveRefToLibrary(index) {
  var img = creativesState.referenceImages[index];
  if (!img || !img.file) return;
  var formData = new FormData();
  formData.append('image', img.file);
  fetch('/api/creatives/reference-images', { method: 'POST', credentials: 'same-origin', body: formData })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) showAutosaveIndicator();
    })
    .catch(function(e) { showCreativesError('Save to library failed: ' + e.message); });
}

function renderAdCard(ad) {
  const platforms = (ad.publisherPlatforms || []).map(function(p) {
    return '<span style="background:#e8f4fd;color:#1a6fa8;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;text-transform:uppercase">' + esc(p) + '</span>';
  }).join(' ');
  const analysisHtml = ad.analysis
    ? '<div style="background:#f8f9fa;border-radius:6px;padding:0.75rem;margin-top:0.75rem;font-size:13px">' +
      '<div style="font-weight:600;margin-bottom:0.25rem">' + esc(ad.analysis.headline || '') + '</div>' +
      '<div class="muted">' + esc(ad.analysis.whyEffective || '') + '</div>' +
      (ad.analysis.messagingAngle ? '<div style="margin-top:0.5rem"><span style="font-weight:600">Angle:</span> ' + esc(ad.analysis.messagingAngle) + '</div>' : '') +
      '</div>'
    : '';
  return '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;display:flex;flex-direction:column">' +
    '<div style="padding:0.875rem 1rem 0.75rem;border-bottom:1px solid #f3f4f6">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.35rem">' +
    '<span style="font-weight:700;font-size:14px">' + esc(ad.pageName) + '</span>' +
    '<span style="font-size:11px;color:#6b7280;white-space:nowrap;margin-left:0.5rem">Score: ' + ad.effectivenessScore + '</span>' +
    '</div>' +
    '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">' +
    platforms +
    '<span style="font-size:11px;color:#6b7280">Running ' + ad.longevityDays + 'd</span>' +
    '<span style="font-size:11px;color:#6b7280">' + ad.variationCount + ' variations</span>' +
    '</div></div>' +
    (ad.adSnapshotUrl ? '<iframe src="' + esc(ad.adSnapshotUrl) + '" style="width:100%;height:280px;border:none" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>' : '') +
    '<div style="padding:0.75rem 1rem;font-size:13px;flex:1">' +
    (ad.adCreativeBody ? '<div style="margin-bottom:0.5rem">' + esc(ad.adCreativeBody.slice(0, 200)) + (ad.adCreativeBody.length > 200 ? '\u2026' : '') + '</div>' : '') +
    analysisHtml +
    '</div>' +
    '<div style="padding:0.75rem 1rem;border-top:1px solid #f3f4f6">' +
    '<button data-ad-id="' + esc(ad.id) + '" data-page-name="' + esc(ad.pageName) + '" onclick="openCreativeGenerator(this.dataset.adId,this.dataset.pageName)" style="width:100%;padding:0.5rem;background:#1a6fa8;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">Generate Creative</button>' +
    '</div></div>';
}

function openCreativeGenerator(adId, pageName) {
  const name = prompt('Generate creative for "' + pageName + '".\n\nEnter product image filenames (comma-separated, from data/product-images/) or leave blank for lifestyle-only:\nExample: deodorant-stick.webp,deodorant-lifestyle.webp');
  // name=null means user cancelled; name='' means they left it blank (lifestyle-only) — both are valid
  if (name === null) return; // user cancelled the prompt
  const productImages = name ? name.split(',').map(s => s.trim()).filter(Boolean) : [];
  // productImages may be empty — that's valid (lifestyle-only prompt, no product reference)
  generateCreative(adId, productImages);
}

async function generateCreative(adId, productImages) {
  try {
    const res = await fetch('/api/generate-creative', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adId, productImages }),
    });
    if (!res.ok) { const e = await res.json(); alert('Error: ' + (e.error || res.status)); return; }
    const { jobId } = await res.json();
    alert('Creative generation started! Job ID: ' + jobId + '\n\nThe download link will appear here when ready. Check back in ~2 minutes.');
    pollCreativeJob(jobId);
  } catch (e) { alert('Error: ' + e.message); }
}

async function pollCreativeJob(jobId, attempts = 0) {
  if (attempts > 30) { alert('Creative generation timed out. Check the dashboard for errors.'); return; }
  await new Promise(r => setTimeout(r, 5000));
  try {
    const res = await fetch('/api/creative-packages/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
    const job = await res.json();
    if (job.status === 'complete') {
      if (confirm('Creative package ready! Download now?')) window.location.href = '/api/creative-packages/download/' + encodeURIComponent(jobId);
    } else if (job.status === 'error') {
      alert('Creative generation failed: ' + (job.error || 'unknown error'));
    } else {
      pollCreativeJob(jobId, attempts + 1);
    }
  } catch { pollCreativeJob(jobId, attempts + 1); }
}

function renderAdsTab(data) {
  renderAdsOptimization(data);
  const adsAll = data.cro?.googleAdsAll || [];
  const snap = adsAll[0];

  if (!snap) {
    document.getElementById('ads-keywords-card').innerHTML = '';
    return;
  }

  // Top keywords card
  const kws = snap.topKeywords || [];
  document.getElementById('ads-keywords-card').innerHTML =
    '<div class="card"><div class="card-header"><h2>Top Keywords</h2>' +
    '<span class="section-note">by conversions</span></div>' +
    '<div class="card-body table-wrap">' +
    (kws.length === 0 ? '<p class="empty-state">No keyword data yet.</p>' :
      '<table><thead><tr><th>Keyword</th><th>Match</th><th>QS</th><th>Clicks</th><th>CVR</th><th>CPC</th><th>Conv</th></tr></thead><tbody>' +
      kws.map(k =>
        '<tr><td>' + esc(k.keyword || '—') + '</td>' +
        '<td>' + esc((k.matchType || '').toLowerCase()) + '</td>' +
        '<td>' + (k.qualityScore || '—') + '</td>' +
        '<td>' + fmtNum(k.clicks) + '</td>' +
        '<td>' + (k.clicks > 0 ? (k.conversions / k.clicks * 100).toFixed(1) + '%' : '—') + '</td>' +
        '<td>$' + (k.avgCpc || 0).toFixed(2) + '</td>' +
        '<td>' + k.conversions + '</td></tr>'
      ).join('') +
      '</tbody></table>') +
    '</div></div>';
}

    function renderToolActionCard(tc, tr) {
      var label = tc.tool === 'approve_suggestion' ? 'Suggestion approved' :
                  tc.tool === 'reject_suggestion'  ? 'Suggestion rejected' :
                                                     'Suggestion updated & approved';
      var detail = tr ? esc(tr.content) : '';
      return '<div style="display:flex;gap:8px;margin-bottom:10px">' +
        '<div style="width:24px;flex-shrink:0"></div>' +
        '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:8px 12px;font-size:11px;color:#166534;display:flex;align-items:center;gap:8px;max-width:480px">' +
          '<span style="font-size:14px">&#9881;&#65039;</span>' +
          '<div><div style="font-weight:700;margin-bottom:2px">' + label + '</div>' +
          '<div style="font-family:monospace;color:#166534">' + esc(detail) + '</div></div>' +
        '</div>' +
      '</div>';
    }

    function renderChatMessages(chatArr) {
      var html = '';
      var i = 0;
      while (i < chatArr.length) {
        var m = chatArr[i];
        if (m.role === 'user') {
          html += '<div style="display:flex;gap:8px;margin-bottom:10px;justify-content:flex-end">' +
            '<div style="background:#ede9fe;border:1px solid #c4b5fd;border-radius:8px 0 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(m.content) + '</div>' +
            '<div style="background:#6d28d9;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">Y</div>' +
            '</div>';
          i++;
        } else if (m.role === 'assistant') {
          html += '<div style="display:flex;gap:8px;margin-bottom:10px">' +
            '<div style="background:#818cf8;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">C</div>' +
            '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:0 8px 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(m.content) + '</div>' +
            '</div>';
          if (i + 1 < chatArr.length && chatArr[i + 1].role === 'tool_call') {
            var tc = chatArr[i + 1];
            var tr = (i + 2 < chatArr.length && chatArr[i + 2].role === 'tool_result') ? chatArr[i + 2] : null;
            html += renderToolActionCard(tc, tr);
            i += tr ? 3 : 2;
          } else {
            i++;
          }
        } else {
          i++; // tool_call / tool_result consumed above
        }
      }
      return html;
    }

function renderAdsOptimization(d) {
  var optEl = document.getElementById('ads-opt-body');
  if (!optEl) return;

  var opt = d.adsOptimization || null;
  if (!opt) {
    optEl.innerHTML = '<div class="ads-opt-analysis">No optimization analysis yet. Run Ads Optimizer to generate suggestions.</div>';
    return;
  }

  var pending  = (opt.suggestions || []).filter(function(s) { return s.status === 'pending'; });
  var approved = (opt.suggestions || []).filter(function(s) { return s.status === 'approved'; });
  var applied  = (opt.suggestions || []).filter(function(s) { return s.status === 'applied'; });
  var rejected = (opt.suggestions || []).filter(function(s) { return s.status === 'rejected'; });

  var allActionable = [].concat(pending, approved);
  var actionable = [].concat(
    allActionable.filter(function(s) { return s.type !== 'copy_rewrite'; }),
    allActionable.filter(function(s) { return s.type === 'copy_rewrite'; })
  );

  function confidenceBadge(c) {
    var label = c === 'high' ? 'HIGH' : c === 'medium' ? 'MED' : 'LOW';
    var color = c === 'high' ? '#065f46' : c === 'medium' ? '#92400e' : '#374151';
    var bg    = c === 'high' ? '#d1fae5' : c === 'medium' ? '#fef3c7' : '#f3f4f6';
    return '<span class="badge" style="background:' + bg + ';color:' + color + ';font-size:0.7rem">' + label + '</span>';
  }

  function typeLabel(s) {
    if (s.type === 'keyword_pause') return 'Pause keyword';
    if (s.type === 'keyword_add')   return 'Add keyword';
    if (s.type === 'negative_add')  return 'Add negative';
    if (s.type === 'copy_rewrite')  return 'Rewrite copy';
    return s.type;
  }

  function changeDesc(s) {
    var pc = s.proposedChange || {};
    if (s.type === 'copy_rewrite') return esc(pc.field) + ': &ldquo;' + esc(pc.current) + '&rdquo; &rarr; &ldquo;' + esc(pc.suggested) + '&rdquo;';
    if (s.type === 'keyword_add')  return esc(pc.keyword) + ' [' + esc((pc.matchType || '').toLowerCase()) + ']';
    if (s.type === 'negative_add') return '&minus;' + esc(pc.keyword);
    return esc(s.target);
  }

  function renderSuggestionCard(s) {
    var isApproved = s.status === 'approved';
    var isCopyRewrite = s.type === 'copy_rewrite';
    var maxLen = (s.proposedChange?.field || '').startsWith('headline') ? 30 : 90;
    var currentVal = s.editedValue || s.proposedChange?.suggested || '';

    var copyEditHtml = '';
    if (isCopyRewrite) {
      var count = currentVal.length;
      var over = count > maxLen;
      copyEditHtml =
        '<div style="margin-bottom:0.5rem">' +
        '<input class="ads-copy-edit" id="copy-edit-' + esc(s.id) + '" maxlength="' + maxLen + '" value="' + esc(currentVal) + '" ' +
        'oninput="updateCopyCount(&apos;' + esc(s.id) + '&apos;,' + maxLen + ')" ' +
        'onblur="saveCopyEdit(&apos;' + esc(s.id) + '&apos;,&apos;' + esc(opt.date) + '&apos;)"> ' +
        '<span class="ads-char-count' + (over ? ' over' : '') + '" id="count-' + esc(s.id) + '">' + count + '/' + maxLen + '</span>' +
        '</div>';
    }

    return '<div class="ads-suggestion" id="suggestion-card-' + esc(s.id) + '" style="' + (chatOpen.has(s.id) ? 'border-bottom-left-radius:0;border-bottom-right-radius:0' : '') + '">' +
      '<div class="ads-suggestion-header">' +
        confidenceBadge(s.confidence) +
        '<strong>' + typeLabel(s) + '</strong>' +
        (s.adGroup ? '<span class="badge-type">' + esc(s.adGroup) + '</span>' : '') +
        (isApproved ? '<span class="badge" style="background:#dbeafe;color:#1e40af;font-size:0.7rem">APPROVED</span>' : '') +
      '</div>' +
      '<div class="ads-suggestion-rationale">' + esc(s.rationale) + '</div>' +
      '<div class="ads-suggestion-change">' + changeDesc(s) + '</div>' +
      copyEditHtml +
      '<div class="ads-suggestion-actions">' +
        '<button class="btn-ads-approve" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;approved&apos;)">' +
          (isApproved ? '&#10003; Approved' : 'Approve') +
        '</button>' +
        '<button class="btn-ads-reject" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;rejected&apos;)">Reject</button>' +
        '<button class="btn-ads-discuss" onclick="toggleChat(&apos;' + esc(s.id) + '&apos;)" style="background:#818cf8">&#128172; Discuss</button>' +
      '</div>' +
    '</div>' +
    '<div id="chat-panel-' + esc(s.id) + '" style="display:' + (chatOpen.has(s.id) ? 'block' : 'none') + ';border:1px solid #818cf8;border-top:none;border-radius:0 0 8px 8px;background:#f8fafc;padding:12px">' +
      '<div id="chat-messages-' + esc(s.id) + '" style="max-height:320px;overflow-y:auto">' + renderChatMessages(s.chat || []) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<input id="chat-input-' + esc(s.id) + '" placeholder="Ask a follow-up question..." ' +
          'style="flex:1;padding:7px 10px;border:1px solid #c4b5fd;border-radius:6px;font-size:12px;outline:none;background:#fff" ' +
          'onkeydown="if(event.key===' + "'Enter'" + ')sendChatMessage(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;)">' +
        '<button onclick="sendChatMessage(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;)" ' +
          'style="padding:7px 14px;background:#818cf8;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer">Send</button>' +
      '</div>' +
    '</div>';
  }

  var html = '';
  if (opt.analysisNotes) html += '<div class="ads-opt-analysis">' + esc(opt.analysisNotes) + '</div>';

  if (actionable.length === 0) {
    html += '<p class="empty-state">No pending suggestions. Run Ads Optimizer to generate new analysis.</p>';
  } else {
    html += actionable.map(renderSuggestionCard).join('');
  }

  if (applied.length > 0 || rejected.length > 0) {
    html += '<details class="ads-applied-section"><summary>' + (applied.length + rejected.length) + ' resolved suggestion(s)</summary>' +
      '<div style="margin-top:0.5rem;opacity:0.6">' +
        [].concat(applied, rejected).map(function(s) {
          return '<div style="font-size:0.8rem;padding:0.25rem 0">' +
          '<span class="badge" style="background:' + (s.status === 'applied' ? '#d1fae5' : '#fee2e2') + ';font-size:0.7rem">' + s.status.toUpperCase() + '</span> ' +
          esc(s.target) + ' — ' + esc(s.rationale) +
          '</div>';
        }).join('') +
      '</div></details>';
  }

  optEl.innerHTML = html;
}

async function adsUpdateSuggestion(date, id, status) {
  try {
    var res = await fetch('/ads/' + date + '/suggestion/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    console.error('Failed to update suggestion:', err);
    return;
  }
  loadData();
}

function updateCopyCount(id, maxLen) {
  var input = document.getElementById('copy-edit-' + id);
  var counter = document.getElementById('count-' + id);
  if (!input || !counter) return;
  var count = input.value.length;
  counter.textContent = count + '/' + maxLen;
  counter.className = 'ads-char-count' + (count > maxLen ? ' over' : '');
}

async function saveCopyEdit(id, date) {
  var input = document.getElementById('copy-edit-' + id);
  if (!input) return;
  var maxLen = parseInt(input.getAttribute('maxlength') || '90', 10);
  if (input.value.length > maxLen) return;
  try {
    var res = await fetch('/ads/' + date + '/suggestion/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editedValue: input.value }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    console.error('Failed to save copy edit:', err);
  }
}


async function applyAdsChanges() {
  var logEl = document.getElementById('run-log-apply-ads');
  if (logEl) { logEl.style.display = 'block'; logEl.textContent = ''; }
  var res = await fetch('/apply-ads', { method: 'POST' });
  var reader = res.body.getReader();
  var decoder = new TextDecoder();
  function read() {
    reader.read().then(function(result) {
      if (result.done) { loadData(); return; }
      var lines = decoder.decode(result.value).split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('data: ') && logEl) logEl.textContent += lines[i].slice(6) + '\n';
      }
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
      read();
    });
  }
  read();
}

function renderActiveTests(d) {
  const el = document.getElementById('active-tests-row');
  if (!el) return;
  const tests = d.metaTests || [];
  const active = tests.filter(t => t.status === 'active');
  if (!active.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const today = new Date();
  el.querySelector('.test-pills').innerHTML = active.map(t => {
    const start = new Date(t.startDate);
    const day = Math.floor((today - start) / 86400000) + 1;
    const delta = t.currentDelta;
    const deltaClass = delta == null ? 'tp-delta-flat'
      : delta > 0 ? 'tp-delta-pos' : delta < 0 ? 'tp-delta-neg' : 'tp-delta-flat';
    const deltaStr = delta == null ? '—'
      : (delta > 0 ? '+' : '') + (delta * 100).toFixed(2) + 'pp';
    return '<span class="test-pill">' +
      '<span class="tp-slug">' + esc(t.slug) + '</span>' +
      '<span class="tp-day">Day ' + day + '/28</span>' +
      '<span class="' + deltaClass + '">CTR ' + deltaStr + '</span>' +
      '</span>';
  }).join('');
}

async function loadAdsOptimization() {
  try {
    var res = await fetch('/api/data', { credentials: 'same-origin' });
    var d = await res.json();
    renderAdsOptimization(d);
  } catch(e) { console.error('loadAdsOptimization failed', e); }
}

function toggleChat(id) {
  var panel = document.getElementById('chat-panel-' + id);
  var card  = document.getElementById('suggestion-card-' + id);
  if (!panel) return;
  if (chatOpen.has(id)) {
    chatOpen.delete(id);
    panel.style.display = 'none';
    if (card) { card.style.borderBottomLeftRadius = ''; card.style.borderBottomRightRadius = ''; }
  } else {
    chatOpen.add(id);
    panel.style.display = 'block';
    if (card) { card.style.borderBottomLeftRadius = '0'; card.style.borderBottomRightRadius = '0'; }
  }
}

async function sendChatMessage(date, id) {
  var inputEl = document.getElementById('chat-input-' + id);
  if (!inputEl) return;
  var msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = '';
  inputEl.disabled = true;

  // Append user bubble immediately
  var msgsEl = document.getElementById('chat-messages-' + id);
  if (msgsEl) {
    msgsEl.innerHTML += '<div style="display:flex;gap:8px;margin-bottom:10px;justify-content:flex-end">' +
      '<div style="background:#ede9fe;border:1px solid #c4b5fd;border-radius:8px 0 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(msg) + '</div>' +
      '<div style="background:#6d28d9;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">Y</div>' +
      '</div>';
  }

  // Append Claude bubble with typing indicator
  var bubbleId = 'chat-bubble-' + id + '-' + Date.now();
  if (msgsEl) {
    msgsEl.innerHTML += '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<div style="background:#818cf8;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">C</div>' +
      '<div id="' + bubbleId + '" style="background:#fff;border:1px solid #e2e8f0;border-radius:0 8px 8px 8px;padding:10px 12px;font-size:12px;color:#374151;max-width:480px"><span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span></div>' +
      '</div>';
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  var bubbleEl = document.getElementById(bubbleId);
  var firstChunk = true;
  var done = false;

  function finish() {
    if (done) return;
    done = true;
    if (inputEl) inputEl.disabled = false;
    loadAdsOptimization();
    setTimeout(function() {
      var newMsgs = document.getElementById('chat-messages-' + id);
      if (newMsgs) {
        newMsgs.scrollTop = newMsgs.scrollHeight;
        newMsgs.scrollIntoView({ block: 'nearest' });
      }
    }, 80);
  }

  try {
    var res = await fetch('/ads/' + date + '/suggestion/' + id + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    function read() {
      reader.read().then(function(result) {
        if (result.done) { finish(); return; }
        var lines = decoder.decode(result.value).split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line === 'data: [DONE]') { finish(); return; }
          if (line.startsWith('data: ')) {
            var chunk = line.slice(6);
            if (bubbleEl) {
              if (firstChunk) {
                firstChunk = false;
                bubbleEl.style.color = '#374151';
                bubbleEl.textContent = chunk;
              } else {
                bubbleEl.textContent += chunk;
              }
              if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
            }
          }
        }
        read();
      }).catch(function() { finish(); });
    }
    read();
  } catch(e) {
    if (bubbleEl) { bubbleEl.style.color = '#374151'; bubbleEl.textContent = 'Error: ' + e.message; }
    if (inputEl) inputEl.disabled = false;
  }
}

async function loadData() {
  document.getElementById('spin-icon').textContent = '⟳';
  document.getElementById('spin-icon').classList.add('spin');
  document.getElementById('updated-at').textContent = 'Loading...';
  try {
    const res = await fetch('/api/data', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('API error: ' + res.status + ' ' + await res.text());
    data = await res.json();
    // Populate hero branding
    const nameEl = document.getElementById('site-name');
    const urlEl  = document.getElementById('site-url');
    const logoEl = document.getElementById('hero-logo');
    if (nameEl && data.config) {
      nameEl.textContent = data.config.name || 'SEO Dashboard';
      urlEl.textContent  = data.config.url  || '';
      logoEl.textContent = (data.config.name || 'S').charAt(0).toUpperCase();
    }
    // Show ads tab pill if data present
    if (data.googleAdsAll?.length) document.getElementById('pill-ads').style.display = '';
    // Render hero KPIs
    renderHeroKpis(data);
    document.getElementById('updated-at').textContent = new Date(data.generatedAt).toLocaleTimeString();
    renderDataNeeded(data);
    renderKanban(data);
    renderRankings(data);
    renderPosts(data);
    renderGSCSEOPanel(data);
    renderContentGapCard(data);
    renderCROTab(data);
    renderAdsTab(data);
    loadCampaignCards();
    renderActiveTests(data);
    renderSEOAuthorityPanel(data.ahrefsData);
    renderRankAlertBanner(data.rankAlert);
    if (activeTab === 'optimize') renderOptimizeTab(data);
  } catch(e) {
    console.error(e);
    document.getElementById('updated-at').textContent = 'Error: ' + e.message;
  } finally {
    document.getElementById('spin-icon').textContent = '';
    document.getElementById('spin-icon').classList.remove('spin');
  }
}

loadData();
setInterval(loadData, 3600000);

// ── tab chat ─────────────────────────────────────────────────────────────────

var tabChatOpen = false;
var tabChatMessages = { seo: [], cro: [], ads: [], optimize: [] };
var tabChatInFlight = false;
var TAB_CHAT_NAMES = { seo: 'SEO', cro: 'CRO', ads: 'Ads', 'ad-intelligence': 'Ad Intelligence', optimize: 'Optimize', creatives: 'Creatives' };

function renderTabChatMessages() {
  var msgs = tabChatMessages[activeTab] || [];
  var msgsEl = document.getElementById('tab-chat-messages');
  if (!msgsEl) return;
  if (!msgs.length) {
    msgsEl.innerHTML = '<div class="tab-chat-empty">Ask anything about the data on this tab.<br>I can also create action items for you to review.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'user') {
      html += '<div class="tab-chat-user-bubble">' + esc(m.content) + '</div>';
    } else if (m.role === 'assistant') {
      var aiHtml;
      try { aiHtml = mdToHtml(m.content); } catch(e) { aiHtml = esc(m.content); }
      html += '<div class="tab-chat-ai-bubble">' + aiHtml + '</div>';
      if (m.action) {
        var msgIdx = i;
        html += '<div class="tab-chat-action-card">' +
          '<div class="tab-chat-action-label">&#128203; Proposed Action</div>' +
          '<div class="tab-chat-action-desc">' + esc(m.action.title) + ': ' + esc(m.action.description) + '</div>' +
          '<button class="btn-add-to-queue" id="tab-chat-action-btn-' + msgIdx + '"' +
          (m.action.added ? ' disabled' : '') + '>' +
          (m.action.added ? '&#x2713; Added' : '+ Add to Queue') + '</button>' +
          '</div>';
      }
    }
  }
  msgsEl.innerHTML = html;
  // Attach action button listeners after render
  for (var j = 0; j < msgs.length; j++) {
    if (msgs[j].action && !msgs[j].action.added) {
      (function(idx) {
        var btn = document.getElementById('tab-chat-action-btn-' + idx);
        if (btn) btn.onclick = function() { addTabChatActionItem(activeTab, idx, btn); };
      })(j);
    }
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function toggleTabChat(tab) {
  if (tabChatOpen && activeTab === tab) {
    closeTabChat();
    return;
  }
  tabChatOpen = true;
  var sidebar = document.getElementById('tab-chat-sidebar');
  if (sidebar) sidebar.style.display = 'flex';
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.style.paddingRight = '316px';
  var title = document.getElementById('tab-chat-title');
  if (title) title.textContent = '\\u2736 ' + (TAB_CHAT_NAMES[tab] || tab) + ' Chat';
  ['seo','cro','ads','optimize'].forEach(function(t) {
    var btn = document.getElementById('btn-chat-' + t);
    if (btn) {
      if (t === tab) btn.classList.add('active'); else btn.classList.remove('active');
    }
  });
  renderTabChatMessages();
  var inp = document.getElementById('tab-chat-input');
  if (inp) inp.focus();
}

function closeTabChat() {
  tabChatOpen = false;
  var sidebar = document.getElementById('tab-chat-sidebar');
  if (sidebar) sidebar.style.display = 'none';
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.style.paddingRight = '';
  ['seo','cro','ads','optimize'].forEach(function(t) {
    var btn = document.getElementById('btn-chat-' + t);
    if (btn) btn.classList.remove('active');
  });
}

async function sendTabChatMessage() {
  if (tabChatInFlight) return;
  var inputEl = document.getElementById('tab-chat-input');
  if (!inputEl) return;
  var msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = '';

  if (!tabChatMessages[activeTab]) tabChatMessages[activeTab] = [];
  tabChatMessages[activeTab].push({ role: 'user', content: msg });
  renderTabChatMessages();

  tabChatInFlight = true;
  inputEl.disabled = true;

  // Add typing indicator
  var msgsEl = document.getElementById('tab-chat-messages');
  if (msgsEl) {
    msgsEl.innerHTML += '<div class="tab-chat-ai-bubble" id="tab-chat-typing"><span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span></div>';
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // Build message array for API (user/assistant turns only)
  var apiMessages = tabChatMessages[activeTab]
    .filter(function(m) { return m.role === 'user' || m.role === 'assistant'; })
    .map(function(m) { return { role: m.role, content: m.content }; });

  try {
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: activeTab, messages: apiMessages }),
    });
    if (!res.ok) { throw new Error('Server error ' + res.status); }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var assistantText = '';
    var actionItem = null;

    function readTabChatChunk() {
      reader.read().then(function(result) {
        if (result.done) { finishTabChat(assistantText, actionItem); return; }
        var lines = decoder.decode(result.value).split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line === 'data: [DONE]') { finishTabChat(assistantText, actionItem); return; }
          if (line.startsWith('data: ACTION_ITEM:')) {
            try { actionItem = JSON.parse(line.slice(18)); } catch(e) {}
          } else if (line.startsWith('data: ')) {
            assistantText += line.slice(6).replace(/\\\n/g, '\n');
          }
        }
        readTabChatChunk();
      }).catch(function() { finishTabChat(assistantText, actionItem); });
    }
    readTabChatChunk();
  } catch(e) {
    var typingEl = document.getElementById('tab-chat-typing');
    if (typingEl) typingEl.remove();
    if (!tabChatMessages[activeTab]) tabChatMessages[activeTab] = [];
    tabChatMessages[activeTab].push({ role: 'assistant', content: 'Error: ' + e.message });
    renderTabChatMessages();
    tabChatInFlight = false;
    if (inputEl) inputEl.disabled = false;
  }
}

function finishTabChat(text, action) {
  var typingEl = document.getElementById('tab-chat-typing');
  if (typingEl) typingEl.remove();
  if (!tabChatMessages[activeTab]) tabChatMessages[activeTab] = [];
  var entry = { role: 'assistant', content: text || '(no response)' };
  if (action) entry.action = { title: action.title || '', description: action.description || '', type: action.type || 'chat_action', added: false };
  tabChatMessages[activeTab].push(entry);
  try { renderTabChatMessages(); } catch(e) { console.error('renderTabChatMessages failed:', e); }
  tabChatInFlight = false;
  var inputEl = document.getElementById('tab-chat-input');
  if (inputEl) inputEl.disabled = false;
}

async function addTabChatActionItem(tab, msgIdx, btn) {
  var msgs = tabChatMessages[tab];
  if (!msgs || !msgs[msgIdx] || !msgs[msgIdx].action) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
  var action = msgs[msgIdx].action;
  try {
    var res = await fetch('/api/chat/action-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: tab, title: action.title, description: action.description, type: action.type }),
    });
    var json = await res.json();
    if (json.ok) {
      action.added = true;
      if (btn) { btn.textContent = '\\u2713 Added'; }
      loadData();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Error \\u2014 retry'; }
    }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Error \\u2014 retry'; }
  }
}

// ── keyword detail modal ──────────────────────────────────────────────────────

function openKeywordCard(item) {
  const fmt = v => (v == null || v === '') ? '<span class="muted">—</span>' : esc(String(v));
  const fmtN = v => v == null ? '<span class="muted">—</span>' : fmtNum(v);
  const changeArrow = (v) => {
    if (v == null) return '<span class="muted">—</span>';
    if (v > 0) return '<span class="change-up">↑ ' + v + '</span>';
    if (v < 0) return '<span class="change-down">↓ ' + Math.abs(v) + '</span>';
    return '→ 0';
  };

  const intentsHtml = (item.intents && item.intents.length)
    ? item.intents.map(i => '<span class="badge badge-approved" style="margin-right:4px">' + esc(i) + '</span>').join('')
    : '<span class="muted">—</span>';

  const serpHtml = item.serpFeatures
    ? item.serpFeatures.split(',').map(s => '<span class="badge badge-notranking" style="margin-right:4px">' + esc(s.trim()) + '</span>').join('')
    : '<span class="muted">—</span>';

  const rows = (label, val) =>
    '<tr><td style="color:#6b7280;padding:6px 12px 6px 0;white-space:nowrap;font-size:13px">' + label + '</td>' +
    '<td style="padding:6px 0;font-size:13px">' + val + '</td></tr>';

  const html =
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">' +
    '<div><div style="font-size:18px;font-weight:700;margin-bottom:4px">' + esc(item.keyword) + '</div>' +
    (item.title ? '<div style="color:#6b7280;font-size:13px">' + esc(item.title) + '</div>' : '') +
    '</div>' +
    '<button onclick="closeKeywordCard()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#6b7280;line-height:1">✕</button>' +
    '</div>' +
    '<table style="width:100%;border-collapse:collapse">' +
    rows('Position', item.position != null ? '<strong>#' + item.position + '</strong>' : '<span class="muted">—</span>') +
    rows('Previous Position', item.positionPrev != null ? '#' + item.positionPrev : (item.previousPosition != null ? '#' + item.previousPosition : '<span class="muted">—</span>')) +
    rows('Position Change', changeArrow(item.positionChange)) +
    rows('Volume', fmtN(item.volume)) +
    rows('KD', fmt(item.kd)) +
    rows('CPC', item.cpc != null ? '$' + item.cpc.toFixed(2) : '<span class="muted">—</span>') +
    rows('Traffic (current)', fmtN(item.traffic)) +
    rows('Traffic (previous)', fmtN(item.trafficPrev)) +
    rows('Traffic Change', changeArrow(item.trafficChange)) +
    rows('Country', fmt(item.country)) +
    rows('SERP Features', serpHtml) +
    rows('Intent', intentsHtml) +
    rows('Current URL', item.url ? '<a class="link" href="' + esc(item.url) + '" target="_blank">' + esc(item.url) + '</a>' : '<span class="muted">—</span>') +
    rows('Previous URL', item.urlPrev ? '<a class="link" href="' + esc(item.urlPrev) + '" target="_blank">' + esc(item.urlPrev) + '</a>' : '<span class="muted">—</span>') +
    rows('Last checked', fmt(item.dateCurr)) +
    (item.gsc_clicks != null ? rows('GSC Clicks (90d)', fmtN(item.gsc_clicks)) : '') +
    (item.gsc_impressions != null ? rows('GSC Impressions (90d)', fmtN(item.gsc_impressions)) : '') +
    (item.gsc_ctr != null ? rows('GSC CTR', (item.gsc_ctr * 100).toFixed(1) + '%') : '') +
    '</table>';

  document.getElementById('kw-modal-body').innerHTML = html;
  document.getElementById('kw-modal').style.display = 'flex';
}

function closeKeywordCard() {
  document.getElementById('kw-modal').style.display = 'none';
}

const _kwModal = document.getElementById('kw-modal');
if (_kwModal) _kwModal.addEventListener('click', function(e) {
  if (e.target === this) closeKeywordCard();
});

var _rejectKeyword = null;
var _rejectCardEl  = null;

function rejectKeyword(keyword, cardEl) {
  _rejectKeyword = keyword;
  _rejectCardEl  = cardEl || null;
  document.getElementById('reject-modal-keyword').textContent = keyword;
  document.getElementById('reject-modal-reason').value = '';
  document.getElementById('reject-modal-error').style.display = 'none';
  selectRejectMatch('exact');
  document.getElementById('reject-modal-overlay').style.display = 'flex';
}

function selectRejectMatch(type) {
  ['exact', 'phrase', 'broad'].forEach(function(t) {
    var el    = document.getElementById('reject-opt-' + t);
    var radio = el.querySelector('input[type=radio]');
    if (t === type) {
      el.style.border     = '1.5px solid #6366f1';
      el.style.background = '#f5f3ff';
      radio.checked = true;
    } else {
      el.style.border     = '1.5px solid #e2e8f0';
      el.style.background = '';
      radio.checked = false;
    }
  });
}

function closeRejectModal() {
  document.getElementById('reject-modal-overlay').style.display = 'none';
  _rejectKeyword = null;
  _rejectCardEl  = null;
}

function confirmRejectKeyword() {
  var matchType = document.querySelector('input[name=reject-match]:checked').value;
  var reason    = document.getElementById('reject-modal-reason').value.trim();
  var errEl     = document.getElementById('reject-modal-error');
  errEl.style.display = 'none';
  fetch('/api/reject-keyword', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: _rejectKeyword, matchType: matchType, reason: reason || null }),
  }).then(function(r) { return r.json(); }).then(function(json) {
    if (!json.ok) {
      errEl.textContent = json.error || 'Failed to save rejection.';
      errEl.style.display = 'block';
      return;
    }
    if (_rejectCardEl) _rejectCardEl.remove();
    closeRejectModal();
  }).catch(function() {
    errEl.textContent = 'Network error - rejection not saved.';
    errEl.style.display = 'block';
  });
}

function showRunBanner(script, tabName, success, logId) {
  var tabEl = document.getElementById('tab-' + tabName);
  if (!tabEl) return;
  var bannerId = 'run-banner-' + tabName;
  var existing = document.getElementById(bannerId);
  if (existing) existing.remove();
  var name = script.split('/').pop().replace('.js', '');
  var banner = document.createElement('div');
  banner.id = bannerId;
  banner.className = 'run-banner ' + (success ? 'run-banner-success' : 'run-banner-error');
  var showLog = !success ? ' &mdash; <a href="#" onclick="var el=document.getElementById(&quot;' + esc(logId) + '&quot;);el.style.display=&quot;block&quot;;el.scrollIntoView({behavior:&quot;smooth&quot;,block:&quot;nearest&quot;});return false">show log</a>' : '';
  banner.innerHTML = (success ? '&#10003; ' : '&#10007; ') + esc(name) + (success ? ' completed' : ' failed') + showLog +
    '<button class="run-banner-dismiss" onclick="this.parentNode.remove()">&#10005;</button>';
  tabEl.insertBefore(banner, tabEl.firstChild);
}

function runAgent(script, args, onDone) {
  if (args === undefined) args = [];
  if (onDone === undefined) onDone = null;
  var logId = 'run-log-' + script.replace(/[^a-z0-9]/gi, '-');
  var logEl = document.getElementById(logId);
  if (!logEl) return;
  logEl.textContent = 'Running...\n';
  logEl.style.display = 'block';
  var capturedTab = activeTab;
  var exitCode = null;
  fetch('/run-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: script, args: args }),
  }).then(function(res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    function read() {
      reader.read().then(function(chunk) {
        if (chunk.done) {
          logEl.style.display = 'none';
          showRunBanner(script, capturedTab, exitCode === 0, logId);
          if (onDone) onDone(); else loadData();
          return;
        }
        var lines = decoder.decode(chunk.value).split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.startsWith('data: __exit__:')) {
            try { exitCode = JSON.parse(line.slice(15)).code; } catch(e) {}
          } else if (line.startsWith('data: ')) {
            logEl.textContent += line.slice(6) + '\n';
          }
        }
        logEl.scrollTop = logEl.scrollHeight;
        read();
      }).catch(function() {
        logEl.style.display = 'none';
        showRunBanner(script, capturedTab, false, logId);
      });
    }
    read();
  }).catch(function() {
    logEl.style.display = 'none';
    showRunBanner(script, capturedTab, false, logId);
  });
}

function promptAndRun(script, argLabel) {
  const val = prompt(argLabel);
  if (val) runAgent(script, [val]);
}

function renderSEOAuthorityPanel(ahrefs) {
  const el = document.getElementById('seo-authority-panel');
  if (!el) return;
  if (!ahrefs) {
    el.innerHTML = '<div class="data-needed"><strong>&#9888; SEO Authority Data Needed</strong>Click Update to enter your Ahrefs metrics.</div>';
    return;
  }
  const fmt    = v => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v).toLocaleString() : '\u2014';
  const fmtDr  = v => (v != null && v !== '') ? v : '\u2014';
  const fmtVal = v => (v != null && v !== '' && !isNaN(Number(v))) ? '$' + (Number(v) / 100).toLocaleString() : '\u2014';
  el.innerHTML =
    '<div class="authority-row">' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmtDr(ahrefs.domainRating) + '</div><div class="authority-stat-label">Domain Rating</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmt(ahrefs.backlinks) + '</div><div class="authority-stat-label">Backlinks</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmt(ahrefs.referringDomains) + '</div><div class="authority-stat-label">Referring Domains</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmtVal(ahrefs.organicTrafficValue) + '</div><div class="authority-stat-label">Organic Traffic Value</div></div>' +
    '</div>';
}

function openAhrefsModal() {
  const ov = document.getElementById('ahrefs-modal-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  try { document.getElementById('ahrefs-dr').focus(); } catch(e) {}
}

function closeAhrefsModal(e) {
  if (e && e.target !== document.getElementById('ahrefs-modal-overlay')) return;
  document.getElementById('ahrefs-modal-overlay').style.display = 'none';
}

async function saveAhrefsOverview() {
  const btn = document.getElementById('ahrefs-save-btn');
  const dr = document.getElementById('ahrefs-dr').value.trim();
  const backlinks = document.getElementById('ahrefs-backlinks').value.trim();
  const refdomains = document.getElementById('ahrefs-refdomains').value.trim();
  const value = document.getElementById('ahrefs-value').value.trim();
  if (!dr && !backlinks && !refdomains && !value) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
  try {
    const res = await fetch('/api/ahrefs-overview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domainRating: dr, backlinks, referringDomains: refdomains, trafficValue: value }),
    });
    const json = await res.json();
    if (json.ok) {
      document.getElementById('ahrefs-modal-overlay').style.display = 'none';
      loadData();
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

function uploadKeywordZip(slug, keyword) {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = function() {
    document.body.removeChild(input);
    var file = input.files[0];
    if (!file) return;
    var btn = document.getElementById('kw-zip-btn-' + slug);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
    fetch('/upload/ahrefs-keyword-zip', {
      method: 'POST',
      headers: { 'X-Slug': slug, 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(function(r) { return r.json(); }).then(function(json) {
      if (!json.ok) {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload Zip'; }
        alert('Upload failed: ' + json.error);
        return;
      }
      loadData(); // remove row from data-needed immediately
      if (btn) btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>';
      runAgent('agents/content-researcher/index.js', [keyword], function() {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Brief created'; }
        loadData();
      });
    }).catch(function() {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload Zip'; }
    });
  };
  input.click();
}

function uploadContentGapZip() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = function() {
    document.body.removeChild(input);
    var file = input.files[0];
    if (!file) return;
    var btn = document.getElementById('content-gap-upload-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
    fetch('/upload/content-gap-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(function(r) { return r.json(); }).then(function(json) {
      if (!json.ok) { if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload Zip'; } alert('Upload failed: ' + json.error); return; }
      if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Uploaded'; }
      loadData();
    }).catch(function() {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload Zip'; }
    });
  };
  input.click();
}

function runGapAnalysis() {
  var btn = document.getElementById('content-gap-run-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
  runAgent('agents/content-gap/index.js', [], function() {
    runAgent('agents/content-strategist/index.js', [], function() {
      runAgent('agents/pipeline-scheduler/index.js', [], function() {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Done'; }
        loadData();
      });
    });
  });
}

function renderContentGapCard(d) {
  var uploaded = d.contentGapFiles || [];
  var el = document.getElementById('content-gap-files');
  var runBtn = document.getElementById('content-gap-run-btn');
  if (!el) return;

  var names = uploaded.map(function(f) { return f.name; });
  var mtimeOf = {};
  uploaded.forEach(function(f) { mtimeOf[f.name] = f.mtime; });

  var EXPECTED = [
    { file: 'top100.csv',                       label: 'Content gap (top 100)' },
    { file: 'realskincare_organic_keywords.csv', label: 'RSC organic keywords' },
    { file: 'natural_deodorant.csv',             label: 'Natural deodorant' },
    { file: 'natural_toothpaste.csv',            label: 'Natural toothpaste' },
    { file: 'natural_body_lotion.csv',           label: 'Natural body lotion' },
    { file: 'natural_lip_balm.csv',              label: 'Natural lip balm' },
    { file: 'natural_bar_soap.csv',              label: 'Natural bar soap' },
    { file: 'natural_hand_soap.csv',             label: 'Natural hand soap' },
    { file: 'natural_coconut_oil.csv',           label: 'Natural coconut oil' },
    { file: 'top_pages_*',                       label: 'Competitor top pages' },
  ];

  function isPresent(spec) {
    if (spec.file === 'top_pages_*') return names.some(function(n) { return n.startsWith('top_pages_') && n.endsWith('.csv'); });
    return names.indexOf(spec.file) !== -1;
  }

  function dateStr(spec) {
    if (spec.file === 'top_pages_*') {
      var match = uploaded.filter(function(f) { return f.name.startsWith('top_pages_') && f.name.endsWith('.csv'); });
      if (!match.length) return '';
      var latest = match.reduce(function(a, b) { return a.mtime > b.mtime ? a : b; });
      return new Date(latest.mtime).toLocaleDateString();
    }
    return mtimeOf[spec.file] ? new Date(mtimeOf[spec.file]).toLocaleDateString() : '';
  }

  function extraNames(spec) {
    if (spec.file !== 'top_pages_*') return '';
    var matches = names.filter(function(n) { return n.startsWith('top_pages_') && n.endsWith('.csv'); });
    return matches.length ? matches.map(function(n) { return n.replace('top_pages_', '').replace('.csv', ''); }).join(', ') : '';
  }

  el.innerHTML = EXPECTED.map(function(spec) {
    var present = isPresent(spec);
    var extra = extraNames(spec);
    var right = present
      ? ('&#10003; ' + dateStr(spec))
      : '&#8943; awaiting upload';
    return '<div class="gap-file-row ' + (present ? 'present' : 'missing') + '">' +
      '<span><span class="gap-file-row-label">' + esc(spec.label) + '</span>' +
      (extra ? '<span class="gap-file-row-name">(' + esc(extra) + ')</span>' : (spec.file !== 'top_pages_*' ? '<span class="gap-file-row-name">' + esc(spec.file) + '</span>' : '')) +
      '</span>' +
      '<span class="gap-file-row-status">' + right + '</span>' +
      '</div>';
  }).join('');

  var hasRequired = isPresent({ file: 'top100.csv' }) && isPresent({ file: 'realskincare_organic_keywords.csv' });
  if (runBtn) {
    runBtn.disabled = !hasRequired;
    runBtn.title = hasRequired ? '' : 'top100.csv and realskincare_organic_keywords.csv required';
  }
}

function uploadRankSnapshot() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.tsv';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async () => {
    document.body.removeChild(input);
    const file = input.files[0];
    if (!file) return;
    const btn = document.getElementById('rank-upload-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
    try {
      const res = await fetch('/upload/rank-snapshot', {
        method: 'POST',
        headers: { 'X-Filename': file.name, 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const json = await res.json();
      if (!json.ok) {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload CSV'; }
        return;
      }
      // CSV saved — now run rank tracker to process it, then reload
      runAgent('agents/rank-tracker/index.js', [], function() {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Updated'; }
        loadData();
      });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload CSV'; }
    }
  };
  input.click();
}

async function loadCampaignCards() {
  try {
    const res = await fetch('/api/campaigns', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    renderCampaignCards(data.campaigns || data, data.aovBarrier || null);
  } catch {}
}

function formatRationale(text) {
  if (!text) return '';
  // Split on sentence boundaries
  var sentences = (text.match(/[^.!?]+(?:[.!?]+(?:[ ]|$))/g) || [text]).map(function(s) { return s.trim(); }).filter(Boolean);
  if (sentences.length <= 1) return '<span>' + esc(text) + '</span>';

  var summary  = sentences[0];
  // Skip pure-math sentences (lots of = and $ signs) and cap at 5 bullets
  var bullets  = sentences.slice(1).filter(function(s) { return (s.match(/=/g) || []).length < 3; }).slice(0, 5);
  var overflow = sentences.slice(1 + bullets.length);

  var html = '<div class="rationale-summary">' + esc(summary) + '</div>';
  if (bullets.length) {
    html += '<ul class="rationale-bullets">' + bullets.map(function(s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
  }
  if (overflow.length) {
    html += '<details class="rationale-details"><summary>Show full analysis (' + overflow.length + ' more)</summary>' +
      '<ul class="rationale-bullets">' + overflow.map(function(s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
      '</details>';
  }
  return html;
}

function renderCampaignCards(campaigns, aovBarrier) {
  // --- Proposals ---
  const proposals = campaigns.filter(c => (c.status === 'proposed' || c.status === 'approved') && !c.clarificationNeeded);
  const propCard = document.getElementById('campaign-proposals-card');
  const propBody = document.getElementById('campaign-proposals-body');
  if (proposals.length === 0 && aovBarrier) {
    propCard.style.display = '';
    document.getElementById('campaign-proposals-note').textContent = 'Paid search readiness';
    propBody.innerHTML =
      '<div style="padding:4px 0 12px">' +
        '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">No viable campaigns at current AOV</div>' +
        '<div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:16px">' + esc(aovBarrier.message) + '</div>' +
        '<div class="metrics-row" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">' +
          '<div class="metric"><div class="metric-label">Store AOV</div><div class="metric-value">$' + esc(String(aovBarrier.aov.toFixed(2))) + '</div><div class="metric-note">90-day average</div></div>' +
          '<div class="metric"><div class="metric-label">Min ROAS</div><div class="metric-value">' + esc(String(aovBarrier.minRoas)) + '×</div><div class="metric-note">Required threshold</div></div>' +
          '<div class="metric"><div class="metric-label">Max CPA</div><div class="metric-value">$' + esc(String(aovBarrier.breakEvenCpa)) + '</div><div class="metric-note">at ' + esc(String(aovBarrier.minRoas)) + '× ROAS</div></div>' +
          '<div class="metric"><div class="metric-label">Max CPC @ 2% CVR</div><div class="metric-value">$' + esc(String(aovBarrier.breakEvenCpc?.at2pctCvr)) + '</div><div class="metric-note">long-tail threshold</div></div>' +
          '<div class="metric"><div class="metric-label">Max CPC @ 3% CVR</div><div class="metric-value">$' + esc(String(aovBarrier.breakEvenCpc?.at3pctCvr)) + '</div><div class="metric-note">branded threshold</div></div>' +
        '</div>' +
        '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px">Recommendations</div>' +
        '<div style="font-size:12px;color:var(--text);line-height:1.8">' +
          '• Current AOV supports keywords up to $' + esc(String((aovBarrier.aov * 0.03 / aovBarrier.minRoas).toFixed(2))) + ' CPC at 3% CVR — target long-tail terms in that range<br>' +
          '• Push AOV to ~$42 via bundles or upsells to unlock $1.50 CPC keywords<br>' +
          '• Brand search is the best near-term bet — CPCs $0.30–0.50, CVR 8–15%<br>' +
          '• See CRO brief for detailed AOV improvement recommendations' +
        '</div>' +
      '</div>';
  } else if (proposals.length > 0) {
    propCard.style.display = '';
    document.getElementById('campaign-proposals-note').textContent = proposals.length + ' pending';
    propBody.innerHTML = proposals.map(c => {
      const p = c.proposal;
      const proj = c.projections || {};
      const isApproved = c.status === 'approved';
      const sugBudget = p.suggestedBudget || 5;
      const approvedBudget = p.approvedBudget || sugBudget;
      const aov = proj.monthlyConversions > 0 ? Math.round(proj.monthlyRevenue / proj.monthlyConversions) : '—';
      const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

      // Status badge
      const statusBadge = isApproved
        ? '<span class="badge badge-published">Approved · $' + approvedBudget + '/day</span>'
        : '<span class="badge badge-draft">Proposed</span>';

      // Budget cell — editable for proposed, display-only for approved
      // JSON.stringify produces double-quoted keys — encode as &quot; for use inside a double-quoted HTML attribute
      const projJson = JSON.stringify(proj).replace(/"/g, '&quot;');
      const budgetCell = isApproved
        ? '<div class="metric budget-metric"><div class="metric-label">Approved Budget</div><div class="metric-value">$' + approvedBudget + ' <span class="metric-unit">/day</span></div><div class="metric-note">$' + (approvedBudget * 30).toFixed(0) + '/mo</div></div>'
        : '<div class="metric budget-metric"><div class="metric-label">Daily Budget</div><div class="budget-row"><span style="font-size:14px;font-weight:700;color:var(--muted)">$</span><input class="budget-input" id="budget-' + esc(c.id) + '" type="number" min="1" step="0.5" value="' + sugBudget + '" data-sug="' + sugBudget + '" data-proj="' + projJson + '" oninput="updateProjections(&apos;' + esc(c.id) + '&apos;)"></div><div class="metric-note">$' + (sugBudget * 30).toFixed(0) + '/mo suggested</div></div>';

      // Ad groups pills
      const adGroupPills = (p.adGroups || []).map(ag =>
        '<span class="adgroup-pill">' + esc(ag.name) + ' <span class="adgroup-kw">· ' + (ag.keywords || []).length + ' kw</span></span>'
      ).join('');
      const negCount = (p.negativeKeywords || []).length;

      // Actions row — note: Approve button uses .btn-camp-approve (not .btn-approve) to avoid collision with CRO section
      const actionsHtml = isApproved
        ? '<button class="btn-launch" onclick="launchCampaign(&apos;' + esc(c.id) + '&apos;)">▶ Launch in Google Ads</button>' +
          '<button class="btn-dismiss" onclick="dismissCampaign(&apos;' + esc(c.id) + '&apos;)">Dismiss</button>' +
          '<span class="proposal-action-note">Budget approved — ready to go live</span>'
        : '<button class="btn-camp-approve" onclick="approveCampaign(&apos;' + esc(c.id) + '&apos;)">✓ Approve &amp; Set Budget</button>' +
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
          '<div class="metric"><div class="metric-label">Est. Clicks/day</div><div class="metric-value" id="clicks-' + esc(c.id) + '">' + esc(String(proj.dailyClicks || '—')) + ' <span class="metric-unit">clicks</span></div><div class="metric-note">CTR ' + ((proj.ctr || 0) * 100).toFixed(1) + '%</div></div>' +
          '<div class="metric"><div class="metric-label">Monthly Cost</div><div class="metric-value" id="cost-' + esc(c.id) + '">$' + esc(String(proj.monthlyCost || '—')) + '</div><div class="metric-note">$' + esc(String(proj.cpc || '—')) + ' avg CPC</div></div>' +
          '<div class="metric"><div class="metric-label">Est. Conversions</div><div class="metric-value" id="conv-' + esc(c.id) + '">' + esc(String(proj.monthlyConversions || '—')) + ' <span class="metric-unit">/mo</span></div><div class="metric-note">CVR ' + ((proj.cvr || 0) * 100).toFixed(1) + '%</div></div>' +
          '<div class="metric"><div class="metric-label">Est. Revenue</div><div class="metric-value" style="color:var(--green)" id="rev-' + esc(c.id) + '">$' + esc(String(proj.monthlyRevenue || '—')) + '</div><div class="metric-note" id="aov-' + esc(c.id) + '">~$' + aov + '/conversion</div></div>' +
        '</div>' +

        // 3. Rationale
        '<div class="rationale-row"><div class="rationale-label">Why this campaign</div><div class="rationale-text">' + formatRationale(c.rationale || '') + '</div></div>' +

        // 4. Ad groups
        '<div class="adgroups-row"><span class="adgroups-label">Ad Groups</span>' + adGroupPills + (negCount > 0 ? '<span style="font-size:11px;color:var(--muted);margin-left:auto">' + negCount + ' neg. keywords</span>' : '') + '</div>' +

        // 5. Actions
        '<div class="proposal-actions">' + actionsHtml + '</div>' +

        '</div>'
      );
    }).join('');
  } else {
    propCard.style.display = '';
    propBody.innerHTML = '<p class="empty-state">No campaign suggestions yet. Run Campaign Creator to generate proposals.</p>';
    document.getElementById('campaign-proposals-note').textContent = '';
  }

  // --- Clarifications ---
  const clarify = campaigns.filter(c => c.clarificationNeeded && c.clarificationNeeded.length > 0);
  const clarCard = document.getElementById('campaign-clarify-card');
  const clarBody = document.getElementById('campaign-clarify-body');
  if (clarify.length > 0) {
    clarCard.style.display = '';
    clarBody.innerHTML = clarify.map(c =>
      '<div class="camp-proposal"><strong>' + esc(c.id) + '</strong>' +
      '<ol>' + c.clarificationNeeded.map(q => '<li>' + esc(q) + '</li>').join('') + '</ol>' +
      '<textarea id="clarify-text-' + esc(c.id) + '" rows="3" style="width:100%;margin-top:8px" placeholder="Your answer..."></textarea>' +
      '<button style="margin-top:6px" onclick="submitClarification(&apos;' + esc(c.id) + '&apos;)">Submit</button>' +
      '</div>'
    ).join('');
  } else { clarCard.style.display = 'none'; }

  // --- Active campaigns ---
  const active = campaigns.filter(c => c.status === 'active');
  const actCard = document.getElementById('campaign-active-card');
  const actBody = document.getElementById('campaign-active-body');
  if (active.length > 0) {
    actCard.style.display = '';
    actBody.innerHTML = active.map(c => {
      const numDays   = croFilter === '30days' ? 30 : croFilter === '7days' ? 7 : 1;
      const entries   = c.performance.slice(-numDays);
      const recent    = c.performance.slice(-1)[0] || {};
      const aggSpend  = entries.reduce((s, e) => s + (e.spend || 0), 0);
      const aggClicks = entries.reduce((s, e) => s + (e.clicks || 0), 0);
      const aggImpr   = entries.reduce((s, e) => s + (e.impressions || 0), 0);
      const aggConv   = entries.reduce((s, e) => s + (e.conversions || 0), 0);
      const aggCtr    = aggImpr   > 0 ? aggClicks / aggImpr : null;
      const aggCpc    = aggClicks > 0 ? aggSpend  / aggClicks : null;
      const aggCvr    = aggClicks > 0 ? aggConv   / aggClicks : null;
      const budget = c.proposal?.approvedBudget || 0;
      const periodBudget = budget * numDays;
      const spendPct = periodBudget > 0 ? Math.round(aggSpend / periodBudget * 100) : 0;
      const openAlerts = (c.alerts || []).filter(a => !a.resolved);
      const ctrDelta = recent.vsProjection?.ctrDelta ?? null;
      const cpcDelta = recent.vsProjection?.cpcDelta ?? null;
      const cvrDelta = recent.vsProjection?.cvrDelta ?? null;
      const campaignDays = c.googleAds?.createdAt ? Math.floor((Date.now() - new Date(c.googleAds.createdAt)) / 86400000) : '?';
      const spendVal  = aggSpend  > 0 ? '$' + aggSpend.toFixed(2)          : '—';
      const ctrVal    = aggCtr   != null ? (aggCtr  * 100).toFixed(2) + '%' : '—';
      const cpcVal    = aggCpc   != null ? '$' + aggCpc.toFixed(2)          : '—';
      const cvrVal    = aggCvr   != null ? (aggCvr  * 100).toFixed(2) + '%' : '—';
      const fmtDelta  = (v, fmt) => v !== null ? '<span class="camp-kpi-delta ' + (v >= 0 ? 'delta-up' : 'delta-down') + '">' + (v >= 0 ? '+' : '') + fmt(v) + ' vs proj</span>' : '';
      const fmtDeltaInv = (v, fmt) => v !== null ? '<span class="camp-kpi-delta ' + (v <= 0 ? 'delta-up' : 'delta-down') + '">' + (v >= 0 ? '+' : '') + fmt(v) + ' vs proj</span>' : '';
      return '<div class="camp-proposal">' +
        '<div class="camp-proposal-name">' + esc(c.proposal?.campaignName || c.id) + ' <span class="section-note">Day ' + campaignDays + '</span></div>' +
        '<div style="background:#f1f5f9;border-radius:4px;height:5px;margin-bottom:4px"><div style="background:#818cf8;height:5px;border-radius:4px;width:' + Math.min(spendPct, 100) + '%"></div></div>' +
        '<div style="font-size:10px;color:var(--muted);margin-bottom:8px">$' + aggSpend.toFixed(2) + ' of $' + (numDays === 1 ? budget + '/day' : periodBudget.toFixed(0)) + ' (' + spendPct + '%)</div>' +
        '<div class="camp-kpi-grid">' +
          '<div class="camp-kpi"><div class="camp-kpi-value">' + spendVal + '</div><div class="camp-kpi-label">Spend</div></div>' +
          '<div class="camp-kpi"><div class="camp-kpi-value">' + ctrVal + '</div><div class="camp-kpi-label">CTR</div>' + fmtDelta(ctrDelta, v => (v * 100).toFixed(2) + 'pp') + '</div>' +
          '<div class="camp-kpi"><div class="camp-kpi-value">' + cpcVal + '</div><div class="camp-kpi-label">Avg CPC</div>' + fmtDeltaInv(cpcDelta, v => '$' + Math.abs(v).toFixed(2)) + '</div>' +
          '<div class="camp-kpi"><div class="camp-kpi-value">' + cvrVal + '</div><div class="camp-kpi-label">CVR</div>' + fmtDelta(cvrDelta, v => (v * 100).toFixed(2) + 'pp') + '</div>' +
        '</div>' +
        (openAlerts.length > 0 ? '<div style="margin-top:10px">' + openAlerts.map(a =>
          '<span class="alert-badge-inline">' + esc(a.type.replace(/_/g, ' ')) + '</span> ' +
          '<button style="font-size:11px;padding:2px 6px" onclick="resolveAlert(&apos;' + esc(c.id) + '&apos;,&apos;' + esc(a.type) + '&apos;)">Resolve</button> '
        ).join('') + '</div>' : '') +
        '</div>';
    }).join('');
  } else {
    actCard.style.display = '';
    actBody.innerHTML = '<p class="empty-state">No active campaigns yet.</p>';
  }
}

function updateProjections(id) {
  const input = document.getElementById('budget-' + id);
  const newBudget       = parseFloat(input?.value);
  const suggestedBudget = parseFloat(input?.dataset.sug);
  let baseProj = {};
  try { baseProj = JSON.parse(input?.dataset.proj || '{}'); } catch { return; }
  if (!newBudget || newBudget <= 0) return;
  if (!suggestedBudget) { console.warn('updateProjections: suggestedBudget is 0 or missing for campaign', id); return; }
  const ratio = newBudget / suggestedBudget;
  const clicks = Math.round((baseProj.dailyClicks || 0) * ratio);
  const cost   = Math.round((baseProj.monthlyCost || 0) * ratio);
  const conv   = Math.round((baseProj.monthlyConversions || 0) * ratio);
  const rev    = Math.round((baseProj.monthlyRevenue || 0) * ratio);
  const aov = conv > 0 ? Math.round(rev / conv) : '—';
  const clickEl = document.getElementById('clicks-' + id);
  const costEl  = document.getElementById('cost-' + id);
  const convEl  = document.getElementById('conv-' + id);
  const revEl   = document.getElementById('rev-' + id);
  const aovEl   = document.getElementById('aov-' + id);
  if (clickEl) clickEl.innerHTML = clicks + ' <span class="metric-unit">clicks</span>';
  if (costEl)  costEl.textContent = '$' + cost;
  if (convEl)  convEl.innerHTML = conv + ' <span class="metric-unit">/mo</span>';
  if (revEl)   revEl.textContent = '$' + rev;
  if (aovEl)   aovEl.textContent = '~$' + aov + '/conversion';
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

async function dismissCampaign(id) {
  if (!confirm('Dismiss this campaign proposal?')) return;
  try {
    await fetch('/api/campaigns/' + encodeURIComponent(id) + '/dismiss', { method: 'POST', credentials: 'same-origin' });
    document.getElementById('prop-' + id)?.remove();
  } catch (e) { alert('Dismiss failed: ' + e.message); }
}

function launchCampaign(id) {
  if (!confirm('Create this campaign in Google Ads? This cannot be undone.')) return;
  fetch('/run-agent', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: 'agents/campaign-creator/index.js', args: ['--campaign', id] }),
  }).then(res => {
    const reader = res.body.getReader();
    const log = document.getElementById('run-log-apply-ads');
    if (log) { log.style.display = ''; log.textContent = ''; }
    const read = () => reader.read().then(({ done, value }) => {
      if (done) { loadCampaignCards(); return; }
      if (log) log.textContent += new TextDecoder().decode(value);
      read();
    });
    read();
  }).catch(e => alert('Launch failed: ' + e.message));
}

async function submitClarification(id) {
  const text = document.getElementById('clarify-text-' + id)?.value?.trim();
  if (!text) { alert('Please enter your answer before submitting.'); return; }
  try {
    await fetch('/api/campaigns/' + encodeURIComponent(id) + '/clarify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clarificationResponse: text }) });
    alert('Response submitted. Re-analysis is running in the background.');
  } catch (e) { alert('Submit failed: ' + e.message); }
}

async function resolveAlert(campaignId, alertType) {
  try {
    await fetch('/api/campaigns/' + encodeURIComponent(campaignId) + '/alerts/' + encodeURIComponent(alertType) + '/resolve', { method: 'POST', credentials: 'same-origin' });
    loadCampaignCards();
  } catch (e) { alert('Resolve failed: ' + e.message); }
}
