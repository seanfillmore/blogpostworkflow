// agents/dashboard/routes/creatives.js
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, createReadStream, unlinkSync, renameSync, copyFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { GEMINI_MODELS, saveSession, createSession } from '../lib/creatives-store.js';

export default [
  // ── exact matches first ──────────────────────────────────────────────────────

  // GET /api/creatives/templates
  {
    method: 'GET',
    match: '/api/creatives/templates',
    handler(req, res, ctx) {
      try {
        const files = existsSync(ctx.CREATIVE_TEMPLATES_DIR)
          ? readdirSync(ctx.CREATIVE_TEMPLATES_DIR).filter(f => f.endsWith('.json'))
          : [];
        const templates = files.map(f => {
          try { return JSON.parse(readFileSync(join(ctx.CREATIVE_TEMPLATES_DIR, f), 'utf8')); }
          catch { return null; }
        }).filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(templates));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  },

  // POST /api/creatives/templates/from-image (MUST be before POST /api/creatives/templates)
  {
    method: 'POST',
    match: '/api/creatives/templates/from-image',
    handler(req, res, ctx) {
      ctx.upload.single('image')(req, res, async (err) => {
        if (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        if (!req.file) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'image file required' }));
          return;
        }
        try {
          const imageData = readFileSync(req.file.path);
          const base64Image = imageData.toString('base64');
          const mimeType = req.file.mimetype || 'image/jpeg';

          const client = new Anthropic();
          const message = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mimeType, data: base64Image }
                },
                {
                  type: 'text',
                  text: 'Analyze this image and generate a creative ad template. Return a JSON object with these fields: name (string, descriptive template name), prompt (string, detailed image generation prompt describing the style, composition, and visual elements of this image), negativePrompt (string, what to avoid), aspectRatio (string, one of "1:1", "16:9", "9:16", "4:3"). Return ONLY valid JSON, no markdown fences.'
                }
              ]
            }]
          });

          let templateData;
          try {
            const text = message.content[0].text.trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            templateData = JSON.parse(jsonMatch ? jsonMatch[0] : text);
          } catch {
            throw new Error('Failed to parse Claude response as JSON');
          }

          const id = 'tpl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const ext = extname(req.file.originalname || '.jpg') || '.jpg';
          const previewFilename = id + ext;
          const previewPath = join(ctx.CREATIVE_TEMPLATES_PREVIEWS_DIR, previewFilename);
          copyFileSync(req.file.path, previewPath);
          try { unlinkSync(req.file.path); } catch {}

          const template = {
            id,
            name: templateData.name || 'Untitled Template',
            prompt: templateData.prompt || '',
            negativePrompt: templateData.negativePrompt || '',
            aspectRatio: templateData.aspectRatio || '1:1',
            previewImage: previewFilename,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          // Do NOT save to disk here — return the template object unsaved.
          // The client's "Save Template" button will POST to /api/creatives/templates to persist it.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(template));
        } catch (err2) {
          try { unlinkSync(req.file.path); } catch {}
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err2.message }));
        }
      });
    },
  },

  // POST /api/creatives/templates
  {
    method: 'POST',
    match: '/api/creatives/templates',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        if (!data.id || !data.name || !data.prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id, name, and prompt are required' }));
          return;
        }
        try {
          const template = {
            ...data,
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          writeFileSync(join(ctx.CREATIVE_TEMPLATES_DIR, data.id + '.json'), JSON.stringify(template, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(template));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  },

  // GET /api/creatives/models
  {
    method: 'GET',
    match: '/api/creatives/models',
    handler(req, res, ctx) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(GEMINI_MODELS));
    },
  },

  // GET /api/creatives/product-images (exact — must precede product-image/* prefix)
  {
    method: 'GET',
    match: '/api/creatives/product-images',
    handler(req, res, ctx) {
      try {
        if (!existsSync(ctx.PRODUCT_MANIFEST_PATH)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        const manifest = JSON.parse(readFileSync(ctx.PRODUCT_MANIFEST_PATH, 'utf8'));
        const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
        const result = manifest.map(product => {
          const dir = join(ctx.PRODUCT_IMAGES_DIR, product.imageDir || product.id || product.handle || '');
          let images = [];
          if (existsSync(dir)) {
            images = readdirSync(dir).filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()));
          }
          return { ...product, images };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  },

  // GET /api/creatives/reference-images (exact — must precede reference-image/* prefix)
  {
    method: 'GET',
    match: '/api/creatives/reference-images',
    handler(req, res, ctx) {
      try {
        const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
        const files = existsSync(ctx.REFERENCE_IMAGES_DIR)
          ? readdirSync(ctx.REFERENCE_IMAGES_DIR).filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()))
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  },

  // POST /api/creatives/reference-images
  {
    method: 'POST',
    match: '/api/creatives/reference-images',
    handler(req, res, ctx) {
      ctx.upload.single('image')(req, res, (err) => {
        if (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        if (!req.file) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'image file required' }));
          return;
        }
        try {
          const ext = extname(req.file.originalname || '.jpg') || '.jpg';
          const filename = 'ref-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
          const destPath = join(ctx.REFERENCE_IMAGES_DIR, filename);
          renameSync(req.file.path, destPath);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ filename }));
        } catch (err2) {
          try { unlinkSync(req.file.path); } catch {}
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err2.message }));
        }
      });
    },
  },

  // GET /api/creatives/sessions (exact — must precede sessions/:id)
  {
    method: 'GET',
    match: '/api/creatives/sessions',
    handler(req, res, ctx) {
      try {
        const files = existsSync(ctx.CREATIVE_SESSIONS_DIR)
          ? readdirSync(ctx.CREATIVE_SESSIONS_DIR).filter(f => f.endsWith('.json'))
          : [];
        const sessions = files.map(f => {
          try {
            const s = JSON.parse(readFileSync(join(ctx.CREATIVE_SESSIONS_DIR, f), 'utf8'));
            return { id: s.id, name: s.name, updatedAt: s.updatedAt, versionCount: (s.versions || []).length };
          } catch { return null; }
        }).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessions));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  },

  // POST /api/creatives/sessions
  {
    method: 'POST',
    match: '/api/creatives/sessions',
    handler(req, res, ctx) {
      try {
        mkdirSync(ctx.CREATIVE_SESSIONS_DIR, { recursive: true });
        const session = createSession();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  },

  // POST /api/creatives/generate
  {
    method: 'POST',
    match: '/api/creatives/generate',
    handler(req, res, ctx) {
      ctx.upload.array('referenceImages', 20)(req, res, async (err) => {
        if (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        if (!ctx.geminiClient) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Gemini API key not configured' }));
          return;
        }
        try {
          const prompt = req.body.prompt || '';
          const negativePrompt = req.body.negativePrompt || '';
          const model = req.body.model || GEMINI_MODELS[0].id;
          const aspectRatio = req.body.aspectRatio || '1:1';
          const sessionId = req.body.sessionId || null;

          // Load or create session
          let session;
          if (sessionId) {
            const sessionPath = join(ctx.CREATIVE_SESSIONS_DIR, sessionId + '.json');
            session = existsSync(sessionPath)
              ? JSON.parse(readFileSync(sessionPath, 'utf8'))
              : createSession();
          } else {
            session = createSession();
          }

          // Build Gemini request parts
          const parts = [];

          // Add product images from PRODUCT_IMAGES_DIR
          let productImagePaths = [];
          try {
            const rawPaths = req.body.productImagePaths;
            if (rawPaths) {
              if (Array.isArray(rawPaths)) {
                productImagePaths = rawPaths;
              } else if (typeof rawPaths === 'string' && rawPaths.startsWith('[')) {
                productImagePaths = JSON.parse(rawPaths);
              } else if (typeof rawPaths === 'string') {
                productImagePaths = [rawPaths];
              }
            }
          } catch {}
          for (const relPath of productImagePaths) {
            const absPath = join(ctx.PRODUCT_IMAGES_DIR, relPath);
            if (existsSync(absPath)) {
              const imgData = readFileSync(absPath);
              const ext = extname(absPath).toLowerCase();
              const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
              const mimeType = mimeMap[ext] || 'image/jpeg';
              parts.push({ inlineData: { mimeType, data: imgData.toString('base64') } });
            }
          }

          // Add history images (previously generated images used as references)
          let historyImagePaths = [];
          try {
            if (req.body.historyImagePaths) {
              const rawHist = req.body.historyImagePaths;
              if (Array.isArray(rawHist)) {
                historyImagePaths = rawHist;
              } else {
                historyImagePaths = JSON.parse(rawHist);
              }
            }
          } catch {}
          for (const relPath of historyImagePaths) {
            const absPath = join(ctx.CREATIVES_DIR, relPath);
            if (existsSync(absPath)) {
              const imgData = readFileSync(absPath);
              const ext = extname(absPath).toLowerCase();
              const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
              const mimeType = mimeMap[ext] || 'image/jpeg';
              parts.push({ inlineData: { mimeType, data: imgData.toString('base64') } });
            }
          }

          // Add uploaded reference files
          for (const file of (req.files || [])) {
            const imgData = readFileSync(file.path);
            const mimeType = file.mimetype || 'image/jpeg';
            parts.push({ inlineData: { mimeType, data: imgData.toString('base64') } });
            try { unlinkSync(file.path); } catch {}
          }

          // Build full prompt text
          let fullPrompt = prompt;
          // Add aspect ratio instruction to prompt
          const arLabels = { '1:1': 'square (1:1)', '4:5': 'portrait (4:5)', '9:16': 'tall portrait (9:16)', '16:9': 'landscape (16:9)' };
          const arLabel = arLabels[aspectRatio];
          if (arLabel) fullPrompt += '\n\nIMPORTANT: Generate this image in ' + arLabel + ' aspect ratio.';
          if (negativePrompt) {
            fullPrompt += '\nDo NOT include: ' + negativePrompt;
          }
          parts.push({ text: fullPrompt });

          // Call Gemini
          const imageSize = req.body.imageSize || '1K';
          console.log('[Creatives] Generating — model:', model, 'aspectRatio:', aspectRatio, 'imageSize:', imageSize);
          const imageConfig = {};
          if (aspectRatio && aspectRatio !== 'custom') imageConfig.aspectRatio = aspectRatio;
          if (imageSize) imageConfig.imageSize = imageSize;
          const result = await ctx.geminiClient.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig,
            },
          });
          console.log('[Creatives] Gemini response received, checking for image...');

          // Check for safety/policy rejection
          const candidate = result.candidates?.[0];
          if (!candidate) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No candidates returned — possible safety rejection' }));
            return;
          }
          if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'OTHER') {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Image generation blocked by safety policy', finishReason: candidate.finishReason }));
            return;
          }

          // Find the image part in the response
          const imagePart = candidate.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
          if (!imagePart) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No image returned from Gemini' }));
            return;
          }

          // Derive extension from mimeType
          const mimeType = imagePart.inlineData.mimeType;
          const extMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
          const imgExt = extMap[mimeType] || '.png';

          // Save image to disk
          const maxVer = (session.versions || []).reduce((m, v) => Math.max(m, v.version || 0), 0);
          const versionNum = maxVer + 1;
          const imageFilename = `v${versionNum}${imgExt}`;
          const sessionDir = join(ctx.CREATIVES_DIR, session.id);
          ctx.ensureDir(sessionDir);
          const absImagePath = join(sessionDir, imageFilename);
          writeFileSync(absImagePath, Buffer.from(imagePart.inlineData.data, 'base64'));

          // Relative path for client
          const imagePath = session.id + '/' + imageFilename;

          // Add version to session
          const version = {
            version: versionNum,
            imagePath,
            prompt,
            negativePrompt,
            model,
            aspectRatio,
            createdAt: new Date().toISOString()
          };
          if (!session.versions) session.versions = [];
          session.versions.push(version);
          saveSession(session);

          // Auto-generate session name on first generation
          let sessionName = session.name;
          if (versionNum === 1 && session.nameAutoGenerated) {
            try {
              const nameMsg = await ctx.anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 64,
                messages: [{
                  role: 'user',
                  content: 'Generate a short, descriptive session name (3-5 words, title case) for an image generation session with this prompt: ' + prompt + '\nReturn ONLY the name, nothing else.'
                }]
              });
              const generatedName = nameMsg.content[0]?.text?.trim() || session.name;
              session.name = generatedName;
              session.nameAutoGenerated = false;
              sessionName = generatedName;
              saveSession(session);
            } catch {}
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ imagePath, version: versionNum, sessionId: session.id, sessionName }));
        } catch (err2) {
          // Clean up any temp files from multer
          for (const file of (req.files || [])) {
            try { unlinkSync(file.path); } catch {}
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err2.message }));
        }
      });
    },
  },

  // POST /api/creatives/refine
  {
    method: 'POST',
    match: '/api/creatives/refine',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        if (!ctx.geminiClient) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Gemini API key not configured' }));
          return;
        }
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        const { sessionId, refinement, model } = payload;
        const version = parseInt(payload.version, 10);
        if (!sessionId || !version || !refinement) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId, version, and refinement are required' }));
          return;
        }
        try {
          // Load session
          const sessionPath = join(ctx.CREATIVE_SESSIONS_DIR, sessionId + '.json');
          if (!existsSync(sessionPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
          }
          const session = JSON.parse(readFileSync(sessionPath, 'utf8'));

          // Find previous version
          const prevVersion = (session.versions || []).find(v => v.version === version);
          if (!prevVersion) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Version not found' }));
            return;
          }

          // Load previous image from disk
          const prevImagePath = join(ctx.CREATIVES_DIR, prevVersion.imagePath);
          if (!existsSync(prevImagePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Previous image not found on disk' }));
            return;
          }
          const prevImageData = readFileSync(prevImagePath);

          // Detect mime type from file extension
          const prevExt = extname(prevImagePath).toLowerCase();
          const mimeExtMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
          const prevMimeType = mimeExtMap[prevExt] || 'image/jpeg';

          const geminiModel = model || prevVersion.model || GEMINI_MODELS[0].id;

          // Send previous image + refinement text to Gemini
          console.log('[Creatives Refine] model:', geminiModel, 'version:', version, 'refinement:', refinement.slice(0, 80));
          const result = await ctx.geminiClient.models.generateContent({
            model: geminiModel,
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { mimeType: prevMimeType, data: prevImageData.toString('base64') } },
                { text: 'Edit this image with the following changes: ' + refinement }
              ]
            }],
            config: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: {},
            }
          });

          // Check for safety/policy rejection
          const candidate = result.candidates?.[0];
          if (!candidate) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No candidates returned — possible safety rejection' }));
            return;
          }
          if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'OTHER') {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Image refinement blocked by safety policy', finishReason: candidate.finishReason }));
            return;
          }

          // Find the image part
          const imagePart = candidate.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
          if (!imagePart) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No image returned from Gemini' }));
            return;
          }

          // Save new image in original format from Gemini
          const newMimeType = imagePart.inlineData.mimeType;
          const newExtMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
          const newExt = newExtMap[newMimeType] || '.png';

          const maxVer = (session.versions || []).reduce((m, v) => Math.max(m, v.version || 0), 0);
          const newVersionNum = maxVer + 1;
          const newImageFilename = `v${newVersionNum}${newExt}`;
          const sessionDir = join(ctx.CREATIVES_DIR, session.id);
          ctx.ensureDir(sessionDir);
          const absImagePath = join(sessionDir, newImageFilename);
          writeFileSync(absImagePath, Buffer.from(imagePart.inlineData.data, 'base64'));

          const imagePath = session.id + '/' + newImageFilename;

          // Add new version to session with refinement field
          const newVersion = {
            version: newVersionNum,
            imagePath,
            prompt: prevVersion.prompt,
            negativePrompt: prevVersion.negativePrompt,
            refinement,
            model: geminiModel,
            aspectRatio: prevVersion.aspectRatio,
            basedOnVersion: version,
            createdAt: new Date().toISOString()
          };
          session.versions.push(newVersion);
          saveSession(session);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ imagePath, version: newVersionNum }));
        } catch (err2) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err2.message }));
        }
      });
    },
  },

  // POST /api/creatives/package
  {
    method: 'POST',
    match: '/api/creatives/package',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        try {
          const jobId = 'pkg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          ctx.ensureDir(ctx.CREATIVE_JOBS_DIR);
          const jobData = { ...payload, jobId, status: 'pending', createdAt: new Date().toISOString() };
          writeFileSync(join(ctx.CREATIVE_JOBS_DIR, jobId + '.json'), JSON.stringify(jobData, null, 2));
          spawn('node', [join(ctx.ROOT, 'agents/creative-packager/index.js'), '--job-id', jobId], {
            detached: true,
            stdio: 'ignore',
            cwd: ctx.ROOT
          }).unref();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jobId }));
        } catch (err2) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err2.message }));
        }
      });
    },
  },

  // POST /api/generate-creative
  {
    method: 'POST',
    match: '/api/generate-creative',
    handler(req, res, ctx) {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try {
          const { adId, productImages = [] } = JSON.parse(body);
          if (!adId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'adId required' })); return; }
          if (productImages.length > 3) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'max 3 product images' })); return; }
          for (const f of productImages) {
            if (!existsSync(join(ctx.PRODUCT_IMAGES_DIR_MA, f))) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Product image not found: ${f}` })); return; }
          }
          // Find pageId for the adId from latest insights
          let pageId = 'unknown';
          if (existsSync(ctx.META_ADS_INSIGHTS_DIR)) {
            const iFiles = readdirSync(ctx.META_ADS_INSIGHTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
            if (iFiles.length) {
              try {
                const ins = JSON.parse(readFileSync(join(ctx.META_ADS_INSIGHTS_DIR, iFiles[0]), 'utf8'));
                pageId = ins.ads.find(a => a.id === adId)?.pageId || 'unknown';
              } catch {}
            }
          }
          const jobId = `${pageId}-${Date.now()}`;
          mkdirSync(ctx.CREATIVE_JOBS_DIR, { recursive: true });
          writeFileSync(join(ctx.CREATIVE_JOBS_DIR, `${jobId}.json`), JSON.stringify({ status: 'pending', adId, productImages, createdAt: new Date().toISOString() }, null, 2));
          spawn('node', ['agents/creative-packager/index.js', '--job-id', jobId], { detached: true, stdio: 'ignore' }).unref();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jobId }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  },

  // ── regex/prefix matches — more specific first ───────────────────────────────

  // PUT /api/creatives/templates/:id
  {
    method: 'PUT',
    match: (url) => /^\/api\/creatives\/templates\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const id = req.url.split('/').pop();
      const filePath = join(ctx.CREATIVE_TEMPLATES_DIR, id + '.json');
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let updates;
        try { updates = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        try {
          const existing = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : { id };
          const template = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
          writeFileSync(filePath, JSON.stringify(template, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(template));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  },

  // DELETE /api/creatives/templates/:id
  {
    method: 'DELETE',
    match: (url) => /^\/api\/creatives\/templates\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const id = req.url.split('/').pop();
      const filePath = join(ctx.CREATIVE_TEMPLATES_DIR, id + '.json');
      try {
        let previewImage = null;
        if (existsSync(filePath)) {
          try { previewImage = JSON.parse(readFileSync(filePath, 'utf8')).previewImage; } catch {}
          unlinkSync(filePath);
        }
        if (previewImage) {
          const previewPath = join(ctx.CREATIVE_TEMPLATES_PREVIEWS_DIR, previewImage);
          if (existsSync(previewPath)) try { unlinkSync(previewPath); } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  },

  // GET /api/creatives/sessions/:id
  {
    method: 'GET',
    match: (url) => /^\/api\/creatives\/sessions\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const id = req.url.split('/').pop();
      const filePath = join(ctx.CREATIVE_SESSIONS_DIR, id + '.json');
      if (!existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(readFileSync(filePath, 'utf8'));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  },

  // PUT /api/creatives/sessions/:id
  {
    method: 'PUT',
    match: (url) => /^\/api\/creatives\/sessions\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const id = req.url.split('/').pop();
      const filePath = join(ctx.CREATIVE_SESSIONS_DIR, id + '.json');
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let updates;
        try { updates = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        try {
          const existing = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : createSession();
          // Handle deleteVersion
          if (updates.deleteVersion !== undefined) {
            const delVer = parseInt(updates.deleteVersion, 10);
            const verObj = (existing.versions || []).find(v => v.version === delVer);
            existing.versions = (existing.versions || []).filter(v => v.version !== delVer);
            // Delete image file from disk
            if (verObj && verObj.imagePath) {
              const imgFile = join(ctx.CREATIVES_DIR, verObj.imagePath);
              if (existsSync(imgFile)) unlinkSync(imgFile);
            }
            delete updates.deleteVersion;
          }
          // Handle toggleFavorite
          if (updates.toggleFavorite !== undefined) {
            const toggleId = updates.toggleFavorite;
            (existing.versions || []).forEach(function(v) {
              if (v.id === toggleId || v.version === toggleId) v.favorite = !v.favorite;
            });
            delete updates.toggleFavorite;
          }
          const session = saveSession({ ...existing, ...updates, id });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(session));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  },

  // GET /api/creatives/reference-image/:filename
  {
    method: 'GET',
    match: (url) => /^\/api\/creatives\/reference-image\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const filename = req.url.split('/').pop().split('?')[0];
      const absPath = join(ctx.REFERENCE_IMAGES_DIR, filename);
      if (!existsSync(absPath)) { res.writeHead(404); res.end('Not found'); return; }
      const ext2 = extname(absPath).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.writeHead(200, { 'Content-Type': mimeMap[ext2] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      createReadStream(absPath).on('error', () => { res.end(); }).pipe(res);
    },
  },

  // GET /api/creatives/template-preview/:filename
  {
    method: 'GET',
    match: (url) => /^\/api\/creatives\/template-preview\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const filename = req.url.split('/').pop().split('?')[0];
      const absPath = join(ctx.CREATIVE_TEMPLATES_PREVIEWS_DIR, filename);
      if (!existsSync(absPath)) { res.writeHead(404); res.end('Not found'); return; }
      const ext2 = extname(absPath).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.writeHead(200, { 'Content-Type': mimeMap[ext2] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      createReadStream(absPath).on('error', () => { res.end(); }).pipe(res);
    },
  },

  // GET /api/creatives/package/download/:jobId (MUST be before package/:jobId)
  {
    method: 'GET',
    match: (url) => /^\/api\/creatives\/package\/download\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const jobId = req.url.match(/^\/api\/creatives\/package\/download\/([^/]+)$/)[1];
      const jobPath = join(ctx.CREATIVE_JOBS_DIR, jobId + '.json');
      if (!existsSync(jobPath)) { res.writeHead(404); res.end('Not found'); return; }
      try {
        const job = JSON.parse(readFileSync(jobPath, 'utf8'));
        const zipPath = job.zipPath;
        if (!zipPath || !existsSync(zipPath)) { res.writeHead(404); res.end('ZIP not found'); return; }
        const zipName = basename(zipPath);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"` });
        createReadStream(zipPath).pipe(res);
      } catch { res.writeHead(500); res.end('Error'); }
    },
  },

  // GET /api/creatives/package/:jobId (status polling)
  {
    method: 'GET',
    match: (url) => /^\/api\/creatives\/package\/([^/]+)$/.test(url),
    handler(req, res, ctx) {
      const jobId = req.url.match(/^\/api\/creatives\/package\/([^/]+)$/)[1];
      const jobPath = join(ctx.CREATIVE_JOBS_DIR, jobId + '.json');
      if (!existsSync(jobPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'Job not found', downloadUrl: null }));
        return;
      }
      try {
        const job = JSON.parse(readFileSync(jobPath, 'utf8'));
        const age = Date.now() - new Date(job.createdAt).getTime();
        if (age > 10 * 60 * 1000 && job.status !== 'complete') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Job timed out', downloadUrl: null }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: job.status, downloadUrl: job.downloadUrl || null, error: job.error || null }));
      } catch { res.writeHead(500); res.end('{}'); }
    },
  },

  // GET /api/creatives/product-image/* (prefix — after product-images exact)
  {
    method: 'GET',
    match: (url) => url.startsWith('/api/creatives/product-image/'),
    handler(req, res, ctx) {
      const filePath = req.url.slice('/api/creatives/product-image/'.length).split('?')[0];
      const absPath = join(ctx.PRODUCT_IMAGES_DIR, filePath);
      if (!existsSync(absPath)) { res.writeHead(404); res.end('Not found'); return; }
      const ext2 = extname(absPath).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.writeHead(200, { 'Content-Type': mimeMap[ext2] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      createReadStream(absPath).on('error', () => { res.end(); }).pipe(res);
    },
  },

  // GET /api/creatives/image/* (prefix)
  {
    method: 'GET',
    match: (url) => url.startsWith('/api/creatives/image/'),
    handler(req, res, ctx) {
      const filePath = req.url.slice('/api/creatives/image/'.length).split('?')[0];
      const absPath = join(ctx.CREATIVES_DIR, filePath);
      if (!existsSync(absPath)) { res.writeHead(404); res.end('Not found'); return; }
      const ext2 = extname(absPath).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
      const isDownload = req.url.includes('?download=1') || req.url.includes('&download=1');
      const headers = { 'Content-Type': mimeMap[ext2] || 'application/octet-stream' };
      if (isDownload) headers['Content-Disposition'] = 'attachment; filename="' + basename(absPath) + '"';
      else headers['Cache-Control'] = 'public, max-age=3600';
      res.writeHead(200, headers);
      createReadStream(absPath).on('error', () => { res.end(); }).pipe(res);
    },
  },

  // GET /api/creative-packages/download/:jobId (MUST be before /api/creative-packages/:jobId)
  {
    method: 'GET',
    match: (url) => url.startsWith('/api/creative-packages/download/'),
    handler(req, res, ctx) {
      const jobId = req.url.slice('/api/creative-packages/download/'.length);
      const jobPath = join(ctx.CREATIVE_JOBS_DIR, `${jobId}.json`);
      if (!existsSync(jobPath)) { res.writeHead(404); res.end('Not found'); return; }
      try {
        const job = JSON.parse(readFileSync(jobPath, 'utf8'));
        const zipPath = job.zipPath;
        if (!zipPath || !existsSync(zipPath)) { res.writeHead(404); res.end('ZIP not found'); return; }
        const zipName = basename(zipPath);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"` });
        createReadStream(zipPath).pipe(res);
      } catch { res.writeHead(500); res.end('Error'); }
    },
  },

  // GET /api/creative-packages/:jobId (status polling)
  {
    method: 'GET',
    match: (url) => /^\/api\/creative-packages\/[^/]+$/.test(url),
    handler(req, res, ctx) {
      const jobId = req.url.split('/').pop();
      const jobPath = join(ctx.CREATIVE_JOBS_DIR, `${jobId}.json`);
      if (!existsSync(jobPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'Job not found', downloadUrl: null }));
        return;
      }
      try {
        const job = JSON.parse(readFileSync(jobPath, 'utf8'));
        const age = Date.now() - new Date(job.createdAt).getTime();
        if (age > 10 * 60 * 1000 && job.status !== 'complete') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Job timed out', downloadUrl: null }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: job.status, downloadUrl: job.downloadUrl || null, error: job.error || null }));
      } catch { res.writeHead(500); res.end('{}'); }
    },
  },
];
