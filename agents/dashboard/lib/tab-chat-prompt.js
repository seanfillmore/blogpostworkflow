// agents/dashboard/lib/tab-chat-prompt.js
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, ADS_OPTIMIZER_DIR, COMP_BRIEFS_DIR } from './paths.js';
import { parseCalendar, parseRankings, parseCROData, getItemStatus } from './data-parsers.js';

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

export function buildTabChatSystemPrompt(tab) {
  const site = config.name || config.url || 'this site';
  const lines = [
    `You are an expert SEO and digital marketing advisor for ${site}.`,
    `The user is viewing the ${(tab || '').toUpperCase()} tab of their SEO dashboard.`,
    `Answer questions about the data shown, explain trends, and make recommendations.`,
    ``,
    `When you have a specific, concrete action to recommend, include exactly one ACTION_ITEM block at the very end of your response using this format:`,
    `<ACTION_ITEM>{"title": "Short action title", "description": "What should be done and why", "type": "action_type"}</ACTION_ITEM>`,
    `Only include ACTION_ITEM when you have a concrete recommendation the user can act on immediately. Omit it for general advice or clarification responses.`,
    `Keep responses concise (2-4 sentences unless the question requires more detail).`,
    ``,
  ];

  if (tab === 'seo') {
    const rankings = parseRankings();
    const top10 = rankings.items.slice(0, 10).map(r =>
      `${r.keyword || r.slug}: pos ${r.position != null ? r.position : 'unranked'}${r.change != null ? ' (' + (r.change > 0 ? '+' : '') + r.change + ')' : ''}`
    );
    lines.push('KEYWORD RANKINGS (latest):');
    lines.push(top10.length ? top10.join('\n') : 'No ranking data available.');
    const calendar = parseCalendar();
    if (calendar.length) {
      const byStatus = { published: [], scheduled: [], draft: [], written: [], briefed: [], pending: [] };
      for (const c of calendar) {
        const status = getItemStatus(c);
        (byStatus[status] || byStatus.pending).push(`${c.keyword} (${c.publishDate.toISOString().slice(0, 10)})`);
      }
      lines.push('', 'CONTENT PIPELINE STATUS:');
      if (byStatus.published.length) lines.push(`Published (${byStatus.published.length}): ${byStatus.published.join(', ')}`);
      if (byStatus.scheduled.length) lines.push(`Scheduled (${byStatus.scheduled.length}): ${byStatus.scheduled.join(', ')}`);
      if (byStatus.draft.length) lines.push(`Draft (${byStatus.draft.length}): ${byStatus.draft.join(', ')}`);
      if (byStatus.written.length) lines.push(`Written (${byStatus.written.length}): ${byStatus.written.join(', ')}`);
      if (byStatus.briefed.length) lines.push(`Briefed (${byStatus.briefed.length}): ${byStatus.briefed.join(', ')}`);
      if (byStatus.pending.length) lines.push(`Pending/not started (${byStatus.pending.length}): ${byStatus.pending.join(', ')}`);
    }
  } else if (tab === 'cro') {
    const cro = parseCROData();
    if (cro.brief) {
      lines.push('LATEST CRO BRIEF (excerpt):');
      lines.push(cro.brief.content.slice(0, 2000));
    } else {
      lines.push('No CRO brief available yet.');
    }
  } else if (tab === 'ads') {
    if (existsSync(ADS_OPTIMIZER_DIR)) {
      const adsFiles = readdirSync(ADS_OPTIMIZER_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
      if (adsFiles.length) {
        const latest = JSON.parse(readFileSync(join(ADS_OPTIMIZER_DIR, adsFiles[0]), 'utf8'));
        const pending = (latest.suggestions || []).filter(s => s.status === 'pending');
        lines.push(`OPTIMIZATION QUEUE (${pending.length} pending suggestions):`);
        pending.slice(0, 10).forEach(s => {
          lines.push(`- [${s.type}] ${s.campaign || ''}${s.adGroup ? ' / ' + s.adGroup : ''}${s.keyword ? ' — ' + s.keyword : ''}: ${s.rationale || ''}`);
        });
        if (latest.analysisNotes) {
          lines.push('', 'ACCOUNT ANALYSIS:');
          lines.push(latest.analysisNotes.slice(0, 1000));
        }
      } else {
        lines.push('No ads optimization data yet.');
      }
    } else {
      lines.push('No Google Ads data available yet.');
    }
  } else if (tab === 'tech-seo') {
    const reportPath = join(ROOT, 'data', 'reports', 'technical-seo', 'technical-seo-audit.md');
    if (existsSync(reportPath)) {
      const report = readFileSync(reportPath, 'utf8').slice(0, 3000);
      lines.push('Current technical SEO audit report (first 3000 chars):');
      lines.push(report);
    } else {
      lines.push('No technical SEO audit report available yet.');
    }
    const themeAuditPath = join(ROOT, 'data', 'reports', 'theme-seo-audit', 'latest.json');
    if (existsSync(themeAuditPath)) {
      try {
        const theme = JSON.parse(readFileSync(themeAuditPath, 'utf8'));
        lines.push('Theme SEO audit results:');
        lines.push(JSON.stringify(theme, null, 2).slice(0, 2000));
      } catch { /* skip */ }
    }
  } else if (tab === 'optimize') {
    if (existsSync(COMP_BRIEFS_DIR)) {
      const briefFiles = readdirSync(COMP_BRIEFS_DIR).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 5);
      if (briefFiles.length) {
        lines.push('RECENT OPTIMIZATION BRIEFS:');
        briefFiles.forEach(f => {
          try {
            const b = JSON.parse(readFileSync(join(COMP_BRIEFS_DIR, f), 'utf8'));
            lines.push(`- ${b.url || f}: ${(b.proposed_changes || []).length} proposed changes`);
          } catch {}
        });
      } else {
        lines.push('No optimization briefs available yet.');
      }
    } else {
      lines.push('No optimization briefs available yet.');
    }
  }

  return lines.join('\n');
}
