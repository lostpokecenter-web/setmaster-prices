// PriceCharting prices: the daily job uploads one compact file per set (console); the app reads them back.
//   PUT    /prices/pc/import                      (x-import-token)  store one set's file
//   PUT    /prices/pc/hist?game=&console=&shard=  (x-import-token)  store one history shard (the daily job merges in that day's prices)
//   GET    /prices/pc/hist?game=&console=&shard=  (x-import-token for the job, x-app-token for the app)  read a history shard
//   DELETE /prices/pc/all                          (x-import-token)  remove every stored price (when the licence ends: within 30 days)
//   GET    /prices/pc/consoles?game=lorcana        (x-app-token)     the sets stored for a game
//   GET    /prices/pc/set?game=lorcana&console=lorcana-attack-of-the-vine   (x-app-token)  one set's prices
// Storage: an R2 bucket bound as PRICES. Parsing the CSV happens in the daily job, so the Worker only validates and stores.
export const GAMES = ['pokemon', 'mtg', 'yugioh', 'lorcana', 'onepiece', 'digimon', 'fab', 'swu', 'dragonball', 'riftbound', 'gundam', 'sports', 'other'];
export const MAX_BYTES = 8 * 1024 * 1024;
export const HIST_SHARDS = 4; // an item's history lives in shard (id % 4) of its set's history
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

function same(a, b) { // equal strings, compared without stopping at the first difference
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export const importAllowed = (req, env) => !!env.IMPORT_TOKEN && same(req.headers.get('x-import-token') ?? '', env.IMPORT_TOKEN);

/** What a stored file must look like. Returns an error text, or null when fine. */
export function checkFile(f, game, slug) {
  if (!f || typeof f !== 'object') return 'not an object';
  if (f.v !== 1) return 'unknown version';
  if (f.game !== game || f.slug !== slug) return 'game or slug does not match the address';
  if (typeof f.name !== 'string' || !f.name) return 'missing set name';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date ?? '')) return 'bad date';
  if (!Array.isArray(f.items) || !f.items.length) return 'no items';
  for (const it of f.items) {
    if (!it || typeof it.i !== 'number' || typeof it.n !== 'string') return 'bad item';
    for (const k of ['l', 'c', 'w', 'g', 'b', 'm', 'x']) if (it[k] != null && !Number.isInteger(it[k])) return `bad price ${k}`;
  }
  return null;
}

async function importSet(req, env) {
  if (!env.PRICES) return json({ error: 'storage is not set up' }, 503);
  const url = new URL(req.url);
  const game = url.searchParams.get('game') ?? '', slug = url.searchParams.get('console') ?? '';
  if (!GAMES.includes(game) || !SLUG.test(slug)) return json({ error: 'bad game or console' }, 400);
  const text = await req.text();
  if (text.length > MAX_BYTES) return json({ error: 'file too large' }, 413);
  let file;
  try { file = JSON.parse(text); } catch { return json({ error: 'not JSON' }, 400); }
  const bad = checkFile(file, game, slug);
  if (bad) return json({ error: bad }, 400);
  await env.PRICES.put(`pc/${game}/${slug}.json`, text, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { name: file.name, date: file.date, count: String(file.items.length) },
  });
  return json({ ok: true, game, console: slug, items: file.items.length });
}

function histKey(url) {
  const game = url.searchParams.get('game') ?? '', slug = url.searchParams.get('console') ?? '', shard = url.searchParams.get('shard') ?? '';
  if (!GAMES.includes(game) || !SLUG.test(slug) || !/^\d{1,2}$/.test(shard) || Number(shard) >= HIST_SHARDS) return null;
  return `pc/hist/${game}/${slug}/${Number(shard)}.json`;
}

async function putHist(req, env) {
  if (!env.PRICES) return json({ error: 'storage is not set up' }, 503);
  const key = histKey(new URL(req.url));
  if (!key) return json({ error: 'bad game, console or shard' }, 400);
  const text = await req.text();
  if (text.length > MAX_BYTES) return json({ error: 'file too large' }, 413);
  if (!text.startsWith('{"v":1,')) return json({ error: 'not a history file' }, 400);
  await env.PRICES.put(key, text, { httpMetadata: { contentType: 'application/json' } });
  return json({ ok: true });
}

async function getHist(url, env) {
  if (!env.PRICES) return json({ error: 'prices are not available yet' }, 503);
  const key = histKey(url);
  if (!key) return json({ error: 'bad game, console or shard' }, 400);
  const obj = await env.PRICES.get(key);
  if (!obj) return json({ error: 'no history yet' }, 404);
  return new Response(obj.body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=1800' } });
}

async function purgeAll(env) {
  if (!env.PRICES) return json({ error: 'storage is not set up' }, 503);
  let removed = 0, cursor;
  do {
    const page = await env.PRICES.list({ prefix: 'pc/', cursor, limit: 500 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) { await env.PRICES.delete(keys); removed += keys.length; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ ok: true, removed });
}

export async function listConsoles(env, game) {
  const out = [];
  let cursor;
  do {
    const page = await env.PRICES.list({ prefix: `pc/${game}/`, cursor, limit: 1000, include: ['customMetadata'] });
    for (const o of page.objects) {
      const m = o.customMetadata ?? {};
      out.push({ slug: o.key.slice(`pc/${game}/`.length).replace(/\.json$/, ''), name: m.name ?? '', date: m.date ?? '', count: Number(m.count ?? 0) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Which games have stored prices and when they were last updated (for the app's status line). */
export async function status(env) {
  if (!env.PRICES) return { games: {}, cloud: true };
  const games = {};
  for (const g of GAMES) {
    const sets = await listConsoles(env, g);
    if (sets.length) games[g] = { sets: sets.length, updated: sets.map((s) => s.date).sort().pop() };
  }
  return { games, cloud: true, source: 'pricecharting' };
}

/** Routes that need the import token. Returns null when the path is not one of them. */
export async function handleImport(req, env) {
  const p = new URL(req.url).pathname;
  const mine = (p === '/prices/pc/import' && req.method === 'PUT') || (p === '/prices/pc/all' && req.method === 'DELETE') || (p === '/prices/pc/hist' && req.method === 'PUT')
    || (p === '/prices/pc/hist' && req.method === 'GET' && req.headers.has('x-import-token')); // the job reads shards with its own token
  if (!mine) return null;
  if (!importAllowed(req, env)) return json({ error: 'unauthorized' }, 401);
  if (p === '/prices/pc/import') return importSet(req, env);
  if (p === '/prices/pc/hist') return req.method === 'PUT' ? putHist(req, env) : getHist(new URL(req.url), env);
  return purgeAll(env);
}

/** Routes for the app (already checked for the app token). Returns null when the path is not one of them. */
export async function handleRead(req, env) {
  const url = new URL(req.url);
  if (req.method !== 'GET' || !url.pathname.startsWith('/prices/pc/')) return null;
  if (!env.PRICES) return json({ error: 'prices are not available yet' }, 503);
  const game = url.searchParams.get('game') ?? '';
  if (!GAMES.includes(game)) return json({ error: 'bad game' }, 400);
  if (url.pathname === '/prices/pc/hist') return getHist(url, env);
  if (url.pathname === '/prices/pc/consoles') return json({ game, sets: await listConsoles(env, game) }, 200, { 'cache-control': 'private, max-age=600' });
  if (url.pathname === '/prices/pc/set') {
    const slug = url.searchParams.get('console') ?? '';
    if (!SLUG.test(slug)) return json({ error: 'bad console' }, 400);
    const obj = await env.PRICES.get(`pc/${game}/${slug}.json`);
    if (!obj) return json({ error: 'no prices for this set' }, 404);
    return new Response(obj.body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=3600' } });
  }
  return json({ error: 'not found' }, 404);
}
