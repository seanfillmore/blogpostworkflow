import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { writeFileSync } from 'fs';

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const prompt = `A minimalist flat square app icon, 1:1 aspect ratio.
Solid background color: sage green #AEDEAC covering the entire canvas edge to edge.
A single stylized leaf rendered as clean line art in crisp white strokes, uniform stroke weight, centered with generous padding around it.
The leaf is a gentle organic shape with a single center vein, no side veins. Modern, minimal, clean.
No text, no shadows, no gradients, no drop shadows, no 3D effects, no background textures.
Suitable for use as a Meta app icon.`;

console.log('Generating icon via Gemini...');
const response = await gemini.models.generateContent({
  model: 'gemini-3.1-flash-image-preview',
  contents: [{ text: prompt }],
});

const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
if (!part) {
  console.error('No image returned. Full response:');
  console.error(JSON.stringify(response, null, 2));
  process.exit(1);
}

const raw = Buffer.from(part.inlineData.data, 'base64');
const rawPath = '/tmp/app-icon-raw.png';
writeFileSync(rawPath, raw);
const meta = await sharp(rawPath).metadata();
console.log(`Raw image: ${meta.width}x${meta.height} ${meta.format}`);

const outPath = '/tmp/rsc-seo-tools-icon-512.png';
await sharp(rawPath)
  .resize(512, 512, { fit: 'cover' })
  .png()
  .toFile(outPath);

const outMeta = await sharp(outPath).metadata();
console.log(`Saved: ${outPath} (${outMeta.width}x${outMeta.height})`);
