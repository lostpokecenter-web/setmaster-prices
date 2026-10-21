// SetMaster API on Cloudflare Workers (api.lostpokecenter.com).
//   POST /                          scan a card photo (Gemini); same request and answer as the local proxy
//   GET  /justtcg/v1/(games|cards)  forwards to JustTCG with the key kept here (only if JUSTTCG_API_KEY is set)
//   GET  /prices/status             which games have PriceCharting prices stored, and when they were updated
//   GET  /prices/pc/consoles, /prices/pc/set   stored PriceCharting prices (see prices.mjs); PUT /prices/pc/import is for the daily job
// Secrets (set with `wrangler secret put`, never in the app): GEMINI_API_KEY, APP_TOKEN, IMPORT_TOKEN, JUSTTCG_API_KEY (optional).
// Storage: an R2 bucket bound as PRICES.
// Variables (wrangler.toml): MODEL, FALLBACK_MODEL, ALLOWED_ORIGINS.
import scan from './scan.mjs';
import { handleImport, handleRead, status as priceStatus } from './prices.mjs';
import { handleImages } from './images.mjs';

const RETRY_DELAYS = [2000, 4000]; // stays inside the app's 45s timeout
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

/** The web app runs in a browser, so it needs CORS. The phone apps do not. */
function corsHeaders(req, env) {
  const origin = req.headers.get('origin');
  const allowed = String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type,x-app-token', 'access-control-allow-methods': 'GET,POST,OPTIONS', vary: 'origin' };
}

/**
 * Who may call the API. Today: the shared app token, which ships inside the app and so only keeps casual traffic out.
 * Before launch, replace this with a check that the caller has an active subscription (RevenueCat), and keep the
 * per-caller limit below.
 */
async function allowed(req, env) {
  if (!env.APP_TOKEN || req.headers.get('x-app-token') !== env.APP_TOKEN) return { ok: false, res: json({ error: 'unauthorized' }, 401) };
  if (env.LIMITER) { // optional Workers Rate Limiting binding (see wrangler.toml)
    const who = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.LIMITER.limit({ key: who });
    if (!success) return { ok: false, res: json({ error: 'Too many requests. Wait a minute and try again.', upstream_status: 429 }, 429) };
  }
  return { ok: true };
}

const busy = async (res) => {
  if (res.status === 504) return true;
  if (res.status !== 502) return false;
  try { return (await res.clone().json()).upstream_status >= 500; } catch { return false; }
};

/** A scan, with the same patience as the local proxy: retry a brief overload, then try the fallback model. */
export async function handleScan(req, env, sleepFn = sleep) {
  const body = await req.text();
  const run = (e) => scan.fetch(new Request('https://scan.invalid/', { method: 'POST', headers: { 'x-app-token': env.APP_TOKEN, 'content-type': 'application/json' }, body }), e);
  const started = Date.now();
  let out = await run(env);
  for (const delay of RETRY_DELAYS) {
    if (!(await busy(out)) || out.status === 504 || Date.now() - started > 25_000) break;
    await sleepFn(delay);
    out = await run(env);
  }
  if ((out.status === 429 || (await busy(out))) && env.FALLBACK_MODEL && env.FALLBACK_MODEL !== env.MODEL) {
    out = await run({ ...env, MODEL: env.FALLBACK_MODEL });
  }
  return out;
}

async function justTcg(req, env) {
  if (!env.JUSTTCG_API_KEY) return json({ error: 'JUSTTCG_API_KEY is not set on the server.' }, 503);
  const url = new URL(req.url);
  const path = url.pathname.slice('/justtcg'.length) + url.search;
  if (!/^\/v1\/(games|cards)(\?|$)/.test(path)) return json({ error: 'not found' }, 404);
  const up = await fetch('https://api.justtcg.com' + path, { headers: { 'x-api-key': env.JUSTTCG_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  return new Response(await up.text(), { status: up.status, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    const wrap = (res) => { for (const [k, v] of Object.entries(cors)) res.headers.set(k, v); return res; };
    try {
      const url = new URL(req.url);
      if (req.method === 'OPTIONS') return wrap(new Response(null, { status: 204 }));
      if (url.pathname === '/health') return wrap(json({ ok: true }));
      const pics = await handleImages(req, env); // picture uploads use the same job token
      if (pics) return wrap(pics);
      const imported = await handleImport(req, env); // the daily job has its own token, not the app's
      if (imported) return wrap(imported);
      const gate = await allowed(req, env);
      if (!gate.ok) return wrap(gate.res);

      if (url.pathname === '/prices/status' && req.method === 'GET') return wrap(json(await priceStatus(env)));
      if (url.pathname.startsWith('/prices/pc/') && req.method === 'GET') return wrap(await handleRead(req, env));
      if (url.pathname.startsWith('/justtcg/') && req.method === 'GET') return wrap(await justTcg(req, env));
      if (url.pathname === '/' && req.method === 'POST') return wrap(await handleScan(req, env));
      if (url.pathname === '/' || url.pathname.startsWith('/prices') || url.pathname.startsWith('/graded')) {
        // The offline price mirror and graded prices are not hosted: their data is not licensed for a paid app yet.
        return wrap(json({ error: 'not available on this server' }, url.pathname === '/' ? 405 : 404));
      }
      return wrap(json({ error: 'not found' }, 404));
    } catch (e) {
      console.error('Server error:', e);
      return wrap(json({ error: 'Internal server error.' }, 500));
    }
  },
};
