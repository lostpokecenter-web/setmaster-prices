// Card pictures kept on our own storage, so the app loads them from us and not from each game's website.
//   PUT /img/{game}/{name}        (x-import-token)  store one picture ("5000.jpg"); the job skips pictures it already stored
//   GET /img/list?game=&cursor=   (x-import-token)  the names already stored (a page at a time), so the job only fetches new ones
// Storage: an R2 bucket bound as IMAGES. The app reads pictures straight from the bucket's public address (no Worker needed),
// e.g. https://img.lostpokecenter.com/yugioh/46986414.jpg
import { GAMES, importAllowed } from './prices.mjs';
export const MAX_IMAGE = 2 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\.(jpg|png|webp)$/;
const TYPE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export async function handleImages(req, env) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/img/')) return null;
  if (!importAllowed(req, env)) return json({ error: 'unauthorized' }, 401);
  if (!env.IMAGES) return json({ error: 'image storage is not set up' }, 503);
  if (url.pathname === '/img/list' && req.method === 'GET') {
    const game = url.searchParams.get('game') ?? '';
    if (!GAMES.includes(game)) return json({ error: 'bad game' }, 400);
    const r = await env.IMAGES.list({ prefix: `${game}/`, limit: 1000, cursor: url.searchParams.get('cursor') || undefined });
    return json({ names: r.objects.map((o) => o.key.slice(game.length + 1)), cursor: r.truncated ? r.cursor : null });
  }
  const m = url.pathname.match(/^\/img\/([a-z]+)\/([^/]+)$/);
  if (!m || req.method !== 'PUT') return json({ error: 'not found' }, 404);
  const [, game, name] = m;
  if (!GAMES.includes(game)) return json({ error: 'bad game' }, 400);
  if (!NAME.test(name)) return json({ error: 'bad name' }, 400);
  const body = await req.arrayBuffer();
  if (!body.byteLength) return json({ error: 'empty' }, 400);
  if (body.byteLength > MAX_IMAGE) return json({ error: 'too big' }, 413);
  await env.IMAGES.put(`${game}/${name}`, body, { httpMetadata: { contentType: TYPE[name.split('.').pop()], cacheControl: 'public, max-age=31536000, immutable' } });
  return json({ ok: true, bytes: body.byteLength });
}
