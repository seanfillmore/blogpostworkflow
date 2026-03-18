/**
 * Microsoft Clarity API client
 * Endpoint: project-live-insights
 * Reads MICROSOFT_CLARITY_TOKEN from .env
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const TOKEN = process.env.MICROSOFT_CLARITY_TOKEN || env.MICROSOFT_CLARITY_TOKEN;
const ENDPOINT = process.env.MICROSOFT_CLARITY_ENDPOINT || env.MICROSOFT_CLARITY_ENDPOINT
  || 'www.clarity.ms/export-data/api/v1/project-live-insights';

if (!TOKEN) throw new Error('Missing MICROSOFT_CLARITY_TOKEN in .env');

function find(data, metricName) {
  const item = data.find(d => d.metricName === metricName);
  return item?.information?.[0] ?? null;
}

/**
 * Fetch and normalize the Clarity live-insights snapshot.
 * Returns null if no session data is available.
 */
export async function fetchClarityInsights() {
  const url = `https://${ENDPOINT}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Clarity API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const traffic = find(data, 'Traffic');
  const totalSessions = Number(traffic?.totalSessionCount ?? 0);
  if (totalSessions === 0) return null; // no data — skip snapshot

  const eng = find(data, 'EngagementTime');
  const scroll = find(data, 'ScrollDepth');

  const pct = (name) => Number(find(data, name)?.sessionsWithMetricPercentage ?? 0);

  const devices = (data.find(d => d.metricName === 'Device')?.information ?? [])
    .map(d => ({ name: d.name, sessions: Number(d.sessionsCount) }));

  const countries = (data.find(d => d.metricName === 'Country')?.information ?? [])
    .map(d => ({ name: d.name, sessions: Number(d.sessionsCount) }));

  const topPages = (data.find(d => d.metricName === 'PageTitle')?.information ?? [])
    .slice(0, 10)
    .map(d => ({ title: d.name, sessions: Number(d.sessionsCount) }));

  const bots = Number(traffic?.totalBotSessionCount ?? 0);

  return {
    sessions: {
      total: totalSessions,
      bots,
      real: totalSessions - bots,
      distinctUsers: Number(traffic?.distinctUserCount ?? 0),
      pagesPerSession: Number(traffic?.pagesPerSessionPercentage ?? 0),
    },
    engagement: {
      totalTime: Number(eng?.totalTime ?? 0),
      activeTime: Number(eng?.activeTime ?? 0),
    },
    behavior: {
      scrollDepth:       Number(scroll?.averageScrollDepth ?? 0),
      rageClickPct:      pct('RageClickCount'),
      deadClickPct:      pct('DeadClickCount'),
      scriptErrorPct:    pct('ScriptErrorCount'),
      quickbackPct:      pct('QuickbackClick'),
      excessiveScrollPct:pct('ExcessiveScroll'),
    },
    devices,
    countries,
    topPages,
  };
}
