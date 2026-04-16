// agents/dashboard/routes/ads.js
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

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
    handler(req, res, ctx) {
      const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id, 'chat']
      const date = parts[2], id = parts[4];
      if (!date || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing date or id' })); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid date' })); return; }

      const inFlightKey = `${date}/${id}`;
      if (ctx.adsInFlight.has(inFlightKey)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Request already in progress' })); return; }
      ctx.adsInFlight.add(inFlightKey);

      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        const cleanup = () => ctx.adsInFlight.delete(inFlightKey);
        let payload;
        try { payload = JSON.parse(body); } catch { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
        const message = (payload.message || '').trim();
        if (!message) { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'message is required' })); return; }
        if (message.length > 2000) { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'message exceeds 2000 characters' })); return; }

        const filePath = join(ctx.ADS_OPTIMIZER_DIR, `${date}.json`);
        if (!existsSync(filePath)) { cleanup(); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion file not found' })); return; }
        const fileData = JSON.parse(readFileSync(filePath, 'utf8'));
        const suggestion = fileData.suggestions?.find(s => s.id === id);
        if (!suggestion) { cleanup(); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion not found' })); return; }

        // Append user message to chat history
        if (!suggestion.chat) suggestion.chat = [];
        const now = () => new Date().toISOString();
        suggestion.chat.push({ role: 'user', content: message, ts: now() });

        // Reconstruct Anthropic SDK message array from chat history
        const messages = [];
        for (let i = 0; i < suggestion.chat.length; i++) {
          const entry = suggestion.chat[i];
          if (entry.role === 'user') {
            messages.push({ role: 'user', content: entry.content });
          } else if (entry.role === 'assistant') {
            const content = [{ type: 'text', text: entry.content }];
            // Merge adjacent tool_call into this assistant message
            if (i + 1 < suggestion.chat.length && suggestion.chat[i + 1].role === 'tool_call') {
              const tc = suggestion.chat[i + 1];
              content.push({ type: 'tool_use', id: tc.tool_use_id, name: tc.tool, input: tc.input });
              i++; // skip the tool_call entry
            }
            messages.push({ role: 'assistant', content });
          } else if (entry.role === 'tool_result') {
            messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: entry.tool_use_id, content: entry.content }] });
          }
          // tool_call entries are consumed above alongside their assistant message
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

        // Tool definitions
        const ALLOWED_UPDATE_FIELDS = {
          bid_adjust:    ['proposedCpcMicros'],
          keyword_add:   ['keyword', 'matchType'],
          negative_add:  ['keyword', 'matchType'],
          copy_rewrite:  ['suggestedCopy'],
          keyword_pause: [],
        };

        const tools = [
          {
            name: 'approve_suggestion',
            description: 'Approve the suggestion as-is, setting its status to approved.',
            input_schema: { type: 'object', properties: {}, required: [] },
          },
          {
            name: 'reject_suggestion',
            description: 'Reject the suggestion, setting its status to rejected.',
            input_schema: { type: 'object', properties: {}, required: [] },
          },
          {
            name: 'update_suggestion',
            description: 'Modify specific fields of the proposed change and approve the suggestion. Only provide fields valid for this suggestion type.',
            input_schema: {
              type: 'object',
              properties: {
                proposedCpcMicros: { type: 'integer', description: 'New max CPC in micros (bid_adjust only)' },
                keyword:           { type: 'string',  description: 'Keyword text (keyword_add / negative_add only)' },
                matchType:         { type: 'string',  enum: ['EXACT', 'PHRASE', 'BROAD'], description: 'Match type (keyword_add / negative_add only)' },
                suggestedCopy:     { type: 'string',  description: 'Replacement copy text (copy_rewrite only)' },
              },
              required: [],
            },
          },
        ];

        // First Claude call (non-streaming) to detect tool use
        let firstResponse;
        try {
          firstResponse = await ctx.anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: systemPrompt,
            messages,
            tools,
          });
        } catch (err) {
          cleanup();
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          res.write(`data: Error contacting Claude: ${err.message.replace(/\n/g, '\\n')}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // Extract text and tool use from first response
        const textBlock   = firstResponse.content.find(b => b.type === 'text');
        const toolBlock   = firstResponse.content.find(b => b.type === 'tool_use');
        let finalText     = textBlock?.text || '';
        let toolCallEntry = null;
        let toolResultEntry = null;

        if (toolBlock) {
          // Validate and execute tool
          const allowedFields = ALLOWED_UPDATE_FIELDS[suggestion.type] || [];
          let toolSummary = '';

          if (toolBlock.name === 'approve_suggestion') {
            suggestion.status = 'approved';
            toolSummary = 'status: approved';
          } else if (toolBlock.name === 'reject_suggestion') {
            suggestion.status = 'rejected';
            toolSummary = 'status: rejected';
          } else if (toolBlock.name === 'update_suggestion') {
            const input = toolBlock.input || {};
            const changes = [];
            for (const field of allowedFields) {
              if (input[field] !== undefined) {
                const oldVal = suggestion.proposedChange[field];
                suggestion.proposedChange[field] = input[field];
                changes.push(`${field}: ${oldVal} → ${input[field]}`);
              }
            }
            suggestion.status = 'approved';
            toolSummary = [...changes, 'status: approved'].join(' · ');
          }

          toolCallEntry   = { role: 'tool_call',   tool: toolBlock.name, tool_use_id: toolBlock.id, input: toolBlock.input, ts: now() };
          toolResultEntry = { role: 'tool_result', tool_use_id: toolBlock.id, content: toolSummary, ts: now() };

          // Second Claude call (streaming) to get narration after tool execution
          const messagesWithTool = [
            ...messages,
            { role: 'assistant', content: firstResponse.content },
            { role: 'user',      content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: toolSummary }] },
          ];

          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

          try {
            const stream = ctx.anthropic.messages.stream({
              model: 'claude-sonnet-4-6',
              max_tokens: 512,
              system: systemPrompt,
              messages: messagesWithTool,
              tools,
            });
            finalText = '';
            for await (const event of stream) {
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                const chunk = event.delta.text;
                finalText += chunk;
                res.write(`data: ${chunk.replace(/\n/g, '\\n')}\n\n`);
              }
            }
          } catch (err) {
            res.write(`data: Error: ${err.message.replace(/\n/g, '\\n')}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            cleanup();
            return;
          }
        } else {
          // No tool use — write first response text as a single SSE chunk
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          if (finalText) res.write(`data: ${finalText.replace(/\n/g, '\\n')}\n\n`);
        }

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
        cleanup();
      });
    },
  },
  {
    method: 'POST',
    match: (url) => url.startsWith('/ads/') && url.includes('/suggestion/') && !url.endsWith('/chat'),
    handler(req, res, ctx) {
      const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id]
      const date = parts[2], id = parts[4];
      if (!date || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing date or id' })); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid date' })); return; }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
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
      });
    },
  },
];
