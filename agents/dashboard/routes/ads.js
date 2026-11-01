// agents/dashboard/routes/ads.js
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readJsonBody } from '../lib/responses.js';
import { LLM_MODELS } from '../../../config/llm-models.js';
import { transcriptPrompt, actionInstructions, parseAction } from '../lib/chat-transcript.js';

export default [
  {
    method: 'POST',
    match: '/apply-ads',
    handler(req, res, ctx) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const child = spawn('node', [join(ctx.ROOT, 'agents', 'apply-ads-changes', 'index.js')], { cwd: ctx.ROOT });
      let doneSent = false;
      child.stdout.on('data', d => {
        for (const line of String(d).split('\n').filter(Boolean)) {
          if (line.startsWith('DONE ')) {
            try { res.write(`event: done\ndata: ${JSON.stringify(JSON.parse(line.slice(5)))}\n\n`); }
            catch { res.write('event: done\ndata: {}\n\n'); }
            doneSent = true;
          } else {
            res.write(`data: ${line}\n\n`);
          }
        }
      });
      child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => res.write(`data: [err] ${l}\n\n`)));
      child.on('close', () => { if (!doneSent) res.write('event: done\ndata: {}\n\n'); res.end(); });
    },
  },
  {
    method: 'GET',
    match: '/api/campaigns',
    handler(req, res, ctx) {
      const CAMPAIGN_PLANS_DIR = join(ctx.ROOT, 'data', 'campaigns');
      function readCampaigns() {
        if (!existsSync(CAMPAIGN_PLANS_DIR)) return [];
        return readdirSync(CAMPAIGN_PLANS_DIR)
          .filter(f => f.endsWith('.json'))
          .map(f => { try { return JSON.parse(readFileSync(join(CAMPAIGN_PLANS_DIR, f), 'utf8')); } catch { return null; } })
          .filter(Boolean)
          .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      }
      const barrierFile = join(CAMPAIGN_PLANS_DIR, 'aov-barrier.json');
      const aovBarrier = existsSync(barrierFile) ? (() => { try { return JSON.parse(readFileSync(barrierFile, 'utf8')); } catch { return null; } })() : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ campaigns: readCampaigns(), aovBarrier }));
    },
  },
  {
    method: 'POST',
    match: (url) => url.startsWith('/ads/') && url.endsWith('/chat') && url.includes('/suggestion/'),
    async handler(req, res, ctx) {
      const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id, 'chat']
      const date = parts[2], id = parts[4];
      if (!date || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing date or id' })); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid date' })); return; }

      const inFlightKey = `${date}/${id}`;
      if (ctx.adsInFlight.has(inFlightKey)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Request already in progress' })); return; }
      ctx.adsInFlight.add(inFlightKey);

      const cleanup = () => ctx.adsInFlight.delete(inFlightKey);

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        // cleanup() MUST run here. The in-flight key was added before the body was
        // read, and a rejection escaping to the router guard would leave it set — the
        // suggestion would answer 429 forever, with no expiry to recover it.
        cleanup();
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }

      try {
        const message = (payload.message || '').trim();
        if (!message) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'message is required' })); return; }
        if (message.length > 2000) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'message exceeds 2000 characters' })); return; }

        const filePath = join(ctx.ADS_OPTIMIZER_DIR, `${date}.json`);
        if (!existsSync(filePath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion file not found' })); return; }
        const fileData = JSON.parse(readFileSync(filePath, 'utf8'));
        const suggestion = fileData.suggestions?.find(s => s.id === id);
        if (!suggestion) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion not found' })); return; }

        // Append user message to chat history
        if (!suggestion.chat) suggestion.chat = [];
        const now = () => new Date().toISOString();
        suggestion.chat.push({ role: 'user', content: message, ts: now() });

        // Rebuild the conversation as transcript entries. A stored tool_call +
        // tool_result pair becomes one bracketed "action" note, so the model
        // still sees what it already did.
        const history = [];
        for (let i = 0; i < suggestion.chat.length; i++) {
          const entry = suggestion.chat[i];
          if (entry.role === 'user' || entry.role === 'assistant') history.push({ role: entry.role, content: entry.content });
          else if (entry.role === 'tool_call') {
            const result = suggestion.chat[i + 1]?.role === 'tool_result' ? suggestion.chat[++i].content : '';
            history.push({ role: 'action', content: `${entry.tool}${result ? ` (${result})` : ''}` });
          }
        }

        // Build system prompt
        const micros = v => v != null ? `$${(v / 1000000).toFixed(2)} (${v} micros)` : null;
        const otherSuggestions = (fileData.suggestions || []).filter(s => s.id !== suggestion.id);
        const systemPrompt = [
          `You are an expert Google Ads advisor. The user is reviewing an optimization suggestion and may ask questions about it, about the broader campaign, or about Google Ads strategy in general. Answer all questions helpfully — do not refuse or redirect if the question goes beyond the single suggestion.`,
          ``,
          `THIS SUGGESTION:`,
          `Type: ${suggestion.type}`,
          `Campaign: ${suggestion.campaign || 'Unknown'}`,
          `Ad Group: ${suggestion.adGroup || 'Campaign-level'}`,
          suggestion.keyword      ? `Keyword: ${suggestion.keyword}` : null,
          suggestion.matchType    ? `Match Type: ${suggestion.matchType}` : null,
          `Confidence: ${suggestion.confidence || 'unset'}`,
          `Rationale: ${suggestion.rationale}`,
          suggestion.currentCpcMicros  != null ? `Current Max CPC: ${micros(suggestion.currentCpcMicros)}` : null,
          suggestion.proposedCpcMicros != null ? `Proposed Max CPC: ${micros(suggestion.proposedCpcMicros)}` : null,
          suggestion.suggestedCopy     ? `Suggested Copy: ${suggestion.suggestedCopy}` : null,
          suggestion.impressions       != null ? `Impressions: ${suggestion.impressions}` : null,
          suggestion.clicks            != null ? `Clicks: ${suggestion.clicks}` : null,
          suggestion.ctr               != null ? `CTR: ${(suggestion.ctr * 100).toFixed(2)}%` : null,
          suggestion.conversions       != null ? `Conversions: ${suggestion.conversions}` : null,
          suggestion.cvr               != null ? `CVR: ${(suggestion.cvr * 100).toFixed(2)}%` : null,
          suggestion.avgCpcMicros      != null ? `Avg CPC: ${micros(suggestion.avgCpcMicros)}` : null,
          suggestion.costMicros        != null ? `Cost: ${micros(suggestion.costMicros)}` : null,
          otherSuggestions.length > 0  ? `\nOTHER PENDING SUGGESTIONS:\n${otherSuggestions.map(s => `- [${s.type}] ${s.campaign || ''}${s.adGroup ? ' / ' + s.adGroup : ''}${s.keyword ? ' — ' + s.keyword : ''}: ${s.rationale}`).join('\n')}` : null,
          fileData.analysisNotes       ? `\nACCOUNT ANALYSIS:\n${fileData.analysisNotes}` : null,
          ``,
          `INSTRUCTIONS:`,
          `- Use all data above when answering. Never say data is missing if it appears above.`,
          `- Answer general campaign questions using the account analysis and other suggestions as context.`,
          `- Only call approve_suggestion, reject_suggestion, or update_suggestion when the user has explicitly signalled a decision — never speculatively.`,
          `- For update_suggestion, only provide fields valid for this suggestion type (${suggestion.type}).`,
        ].filter(Boolean).join('\n');

        // Fields update_suggestion may change, per suggestion type
        const ALLOWED_UPDATE_FIELDS = {
          bid_adjust:    ['proposedCpcMicros'],
          keyword_add:   ['keyword', 'matchType'],
          negative_add:  ['keyword', 'matchType'],
          copy_rewrite:  ['suggestedCopy'],
          keyword_pause: [],
        };

        const allowedFields = ALLOWED_UPDATE_FIELDS[suggestion.type] || [];

        // One call on the Claude subscription. The three actions
        // (approve_suggestion, reject_suggestion, update_suggestion) used to be API
        // tools; they are now a tagged JSON line that parseAction validates, because
        // tool use cannot run on the subscription and the API key is invalid.
        let response;
        try {
          response = await ctx.anthropic.messages.create({
            model: LLM_MODELS.standard,
            max_tokens: 4096,
            system: `${systemPrompt}\n\n${actionInstructions(suggestion.type, allowedFields)}`,
            messages: [{ role: 'user', content: transcriptPrompt(history) }],
          });
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          res.write(`data: Error contacting Claude: ${err.message.replace(/\n/g, '\\n')}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const replyText = response.content.find(b => b.type === 'text')?.text || '';
        const { text: spoken, action, rejected } = parseAction(replyText, allowedFields);
        let finalText = spoken;
        let toolCallEntry = null;
        let toolResultEntry = null;

        if (action) {
          let toolSummary = '';
          if (action.tool === 'approve_suggestion') {
            suggestion.status = 'approved';
            toolSummary = 'status: approved';
          } else if (action.tool === 'reject_suggestion') {
            suggestion.status = 'rejected';
            toolSummary = 'status: rejected';
          } else if (action.tool === 'update_suggestion') {
            const changes = [];
            for (const field of allowedFields) {
              if (action.input[field] !== undefined) {
                const oldVal = suggestion.proposedChange[field];
                suggestion.proposedChange[field] = action.input[field];
                changes.push(`${field}: ${oldVal} → ${action.input[field]}`);
              }
            }
            suggestion.status = 'approved';
            toolSummary = [...changes, 'status: approved'].join(' · ');
          }
          const actionId = `act_${Date.now()}`;
          toolCallEntry   = { role: 'tool_call',   tool: action.tool, tool_use_id: actionId, input: action.input, ts: now() };
          toolResultEntry = { role: 'tool_result', tool_use_id: actionId, content: toolSummary, ts: now() };
        } else if (rejected) {
          console.error(`[ads-chat] action not applied: ${rejected}`);
          finalText = `${finalText}\n\n(No change was made to the suggestion: ${rejected}. Please say what you want done and I'll try again.)`.trim();
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        if (finalText) res.write(`data: ${finalText.replace(/\n/g, '\\n')}\n\n`);

        // Persist to chat history and write file
        if (finalText) suggestion.chat.push({ role: 'assistant', content: finalText, ts: now() });
        if (toolCallEntry)   suggestion.chat.push(toolCallEntry);
        if (toolResultEntry) suggestion.chat.push(toolResultEntry);

        try {
          writeFileSync(filePath, JSON.stringify(fileData, null, 2));
        } catch (err) {
          console.error('[chat] Failed to write suggestion file:', err.message);
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } finally {
        cleanup();
      }
    },
  },
  {
    method: 'POST',
    match: (url) => url.startsWith('/ads/') && url.includes('/suggestion/') && !url.endsWith('/chat'),
    async handler(req, res, ctx) {
      const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id]
      const date = parts[2], id = parts[4];
      if (!date || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing date or id' })); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid date' })); return; }

      let payload;
      try { payload = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }

      const filePath = join(ctx.ADS_OPTIMIZER_DIR, `${date}.json`);
      if (!existsSync(filePath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion file not found' })); return; }
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      const suggestion = data.suggestions?.find(s => s.id === id);
      if (!suggestion) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion not found' })); return; }
      if (payload.status !== undefined) {
        if (!['approved', 'rejected'].includes(payload.status)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'status must be approved or rejected' })); return; }
        suggestion.status = payload.status;
      }
      if (payload.editedValue !== undefined) {
        if (typeof payload.editedValue !== 'string' || payload.editedValue.length > 200) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid editedValue' })); return; }
        suggestion.editedValue = payload.editedValue;
      }
      writeFileSync(filePath, JSON.stringify(data, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, suggestion }));
    },
  },
];
