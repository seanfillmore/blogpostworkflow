// agents/dashboard/routes/chat.js
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildTabChatSystemPrompt } from '../lib/tab-chat-prompt.js';

export default [
  {
    method: 'POST',
    match: '/api/chat',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        const { tab, messages } = payload;
        if (!tab || !Array.isArray(messages)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'tab and messages required' }));
          return;
        }
        const VALID_TABS = new Set(['seo', 'cro', 'ads', 'optimize', 'ad-intelligence']);
        if (!VALID_TABS.has(tab)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid tab' }));
          return;
        }

        let systemPrompt;
        try { systemPrompt = buildTabChatSystemPrompt(tab); } catch (e) { systemPrompt = `You are an SEO advisor. Data for this tab could not be loaded (${e.message}).`; }
        const cappedMessages = messages.slice(-20).map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: String(m.content || '').slice(0, 4000),
        }));

        let response;
        try {
          response = await ctx.anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: systemPrompt,
            messages: cappedMessages,
          });
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          res.write(`data: Error contacting Claude: ${err.message.replace(/\n/g, '\\n')}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const fullText = (response.content.find(b => b.type === 'text') || {}).text || '';
        const actionMatch = fullText.match(/<ACTION_ITEM>([\s\S]*?)<\/ACTION_ITEM>/);
        const cleanText = fullText.replace(/<ACTION_ITEM>[\s\S]*?<\/ACTION_ITEM>/g, '').trim();

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        if (cleanText) res.write(`data: ${cleanText.replace(/\n/g, '\\n')}\n\n`);
        if (actionMatch) {
          try {
            const actionJson = JSON.parse(actionMatch[1].trim());
            res.write(`data: ACTION_ITEM:${JSON.stringify(actionJson)}\n\n`);
          } catch { /* skip malformed ACTION_ITEM */ }
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    },
  },
  {
    method: 'POST',
    match: '/api/chat/action-item',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }
        const { tab, title, description, type } = payload;
        if (!tab || !title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'tab and title required' }));
          return;
        }

        if (tab === 'ads') {
          const today = new Date().toISOString().slice(0, 10);
          const filePath = join(ctx.ADS_OPTIMIZER_DIR, `${today}.json`);
          let fileData = { analysisNotes: '', suggestions: [] };
          if (existsSync(filePath)) {
            try { fileData = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
          } else {
            mkdirSync(ctx.ADS_OPTIMIZER_DIR, { recursive: true });
          }
          if (!Array.isArray(fileData.suggestions)) fileData.suggestions = [];
          const id = 'chat-' + Date.now();

          // For landing_page_update, extract URL and match campaign resource name from latest snapshot
          let proposedChange = undefined;
          if (type === 'landing_page_update') {
            const text = description || title || '';
            const urlMatch = text.match(/https?:\/\/[^\s,)]+/);
            const finalUrl = urlMatch ? urlMatch[0].replace(/[.,]+$/, '') : null;
            let campaignResourceName = null;
            try {
              const snapDir = join(ctx.ROOT, 'data', 'snapshots', 'google-ads');
              const snapFiles = readdirSync(snapDir).filter(f => f.endsWith('.json')).sort();
              if (snapFiles.length) {
                const snap = JSON.parse(readFileSync(join(snapDir, snapFiles[snapFiles.length - 1]), 'utf8'));
                const textLower = text.toLowerCase();
                const matched = (snap.campaigns || []).find(c => {
                  const parts = c.name.toLowerCase().split(/[\s|]+/).filter(p => p.length > 3);
                  return parts.filter(p => textLower.includes(p)).length >= 2;
                });
                if (matched) campaignResourceName = matched.resourceName;
              }
            } catch {}
            if (finalUrl || campaignResourceName) {
              proposedChange = {};
              if (finalUrl) proposedChange.finalUrl = finalUrl;
              if (campaignResourceName) proposedChange.campaignResourceName = campaignResourceName;
            }
          }

          fileData.suggestions.push({
            id,
            type: type || 'chat_action',
            status: 'pending',
            source: 'chat',
            rationale: description || title,
            campaign: proposedChange?.campaignResourceName || null,
            adGroup: null,
            ...(proposedChange ? { proposedChange } : {}),
          });
          try {
            writeFileSync(filePath, JSON.stringify(fileData, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Action noted' }));
        }
      });
    },
  },
];
