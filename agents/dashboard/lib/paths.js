// agents/dashboard/lib/paths.js
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..', '..');
export const PUBLIC_DIR = join(__dirname, '..', 'public');

export const POSTS_DIR     = join(ROOT, 'data', 'posts');
export const BRIEFS_DIR    = join(ROOT, 'data', 'briefs');
export const IMAGES_DIR    = join(ROOT, 'data', 'images');
export const REPORTS_DIR   = join(ROOT, 'data', 'reports');
export const SNAPSHOTS_DIR = join(ROOT, 'data', 'rank-snapshots');
export const KEYWORD_TRACKER_DIR = join(ROOT, 'data', 'keyword-tracker');
export const ADS_OPTIMIZER_DIR = join(ROOT, 'data', 'ads-optimizer');
export const CALENDAR_PATH = join(REPORTS_DIR, 'content-strategist', 'content-calendar.md');

export const COMP_BRIEFS_DIR      = join(ROOT, 'data', 'competitor-intelligence', 'briefs');
export const COMP_SCREENSHOTS_DIR = join(ROOT, 'data', 'competitor-intelligence', 'screenshots');
export const META_ADS_INSIGHTS_DIR = join(ROOT, 'data', 'meta-ads-insights');
export const CREATIVE_JOBS_DIR      = join(ROOT, 'data', 'creative-jobs');
export const CREATIVE_PACKAGES_DIR  = join(ROOT, 'data', 'creative-packages');
export const PRODUCT_IMAGES_DIR_MA  = join(ROOT, 'data', 'product-images');

export const CREATIVE_TEMPLATES_DIR          = join(ROOT, 'data', 'creative-templates');
export const CREATIVE_TEMPLATES_PREVIEWS_DIR = join(ROOT, 'data', 'creative-templates', 'previews');
export const CREATIVE_SESSIONS_DIR           = join(ROOT, 'data', 'creative-sessions');
export const CREATIVES_DIR                   = join(ROOT, 'data', 'creatives');
export const REFERENCE_IMAGES_DIR            = join(ROOT, 'data', 'reference-images');
export const PRODUCT_IMAGES_DIR              = join(ROOT, 'data', 'product-images');
export const PRODUCT_MANIFEST_PATH           = join(PRODUCT_IMAGES_DIR, 'manifest.json');

export const CLARITY_SNAPSHOTS_DIR    = join(ROOT, 'data', 'snapshots', 'clarity');
export const SHOPIFY_SNAPSHOTS_DIR    = join(ROOT, 'data', 'snapshots', 'shopify');
export const GSC_SNAPSHOTS_DIR        = join(ROOT, 'data', 'snapshots', 'gsc');
export const GA4_SNAPSHOTS_DIR        = join(ROOT, 'data', 'snapshots', 'ga4');
export const GOOGLE_ADS_SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'google-ads');
export const CRO_REPORTS_DIR          = join(ROOT, 'data', 'reports', 'cro');
export const META_TESTS_DIR           = join(ROOT, 'data', 'meta-tests');
export const REJECTED_IMAGES_DIR     = join(ROOT, 'data', 'images', 'rejected');

export const SEO_AUTHORITY_DIR = join(ROOT, 'data', 'reports', 'seo-authority');
export const CONTENT_GAP_DIR = join(ROOT, 'data', 'content_gap');
export const RANK_ALERTS_DIR = join(ROOT, 'data', 'reports', 'rank-alerts');
export const ALERTS_VIEWED   = join(RANK_ALERTS_DIR, '.last-viewed');
