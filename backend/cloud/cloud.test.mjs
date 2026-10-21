import test from 'node:test';
import assert from 'node:assert/strict';
import api, { handleScan } from './index.mjs';

const env = { APP_TOKEN: 't', GEMINI_API_KEY: 'k', MODEL: 'main', FALLBACK_MODEL: 'backup', ALLOWED_ORIGINS: 'https://app.lostpokecenter.com' };
const scanReq = (h = {}) => new Request('https://x/', { method: 'POST', headers: { 'x-app-token': 't', ...h }, body: JSON.stringify({ imageBase64: 'AAAA' }) });
const gemini = (card) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(card) }] } }] }), { status: 200 });
const realFetch = globalThis.fetch;
const withFetch = (fn) => { globalThis.fetch = fn; };
test.afterEach(() => { globalThis.fetch = realFetch; });

test('rejects a missing or wrong token', async () => {
  assert.equal((await api.fetch(new Request('https://x/', { method: 'POST' }), env)).status, 401);
  assert.equal((await api.fetch(scanReq({ 'x-app-token': 'no' }), env)).status, 401);
});
test('health needs no token', async () => {
  assert.equal((await api.fetch(new Request('https://x/health'), env)).status, 200);
});
test('a scan returns the card the model read', async () => {
  withFetch(async () => gemini({ card_name: 'Pikachu', card_number: '25' }));
  const r = await api.fetch(scanReq(), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).card_name, 'Pikachu');
});
test('a rate-limited main model falls back to the second model', async () => {
  const seen = [];
  withFetch(async (url) => { seen.push(String(url)); return seen.length === 1 ? new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 }) : gemini({ card_name: 'Eevee' }); });
  const r = await handleScan(scanReq(), env, async () => {});
  assert.equal(r.status, 200);
  assert.ok(seen[0].includes('/main:') && seen[1].includes('/backup:'));
});
test('a brief overload is retried', async () => {
  let n = 0;
  withFetch(async () => (++n < 2 ? new Response('{}', { status: 503 }) : gemini({ card_name: 'Mew' })));
  const r = await handleScan(scanReq(), { ...env, FALLBACK_MODEL: undefined }, async () => {});
  assert.equal(r.status, 200); assert.equal(n, 2);
});
test('unlicensed price endpoints are not served', async () => {
  const r = await api.fetch(new Request('https://x/prices/search?q=a', { headers: { 'x-app-token': 't' } }), env);
  assert.equal(r.status, 404);
  const st = await api.fetch(new Request('https://x/prices/status', { headers: { 'x-app-token': 't' } }), env);
  assert.deepEqual((await st.json()).games, {});
});
test('JustTCG needs its key and only forwards known paths', async () => {
  const h = { 'x-app-token': 't' };
  assert.equal((await api.fetch(new Request('https://x/justtcg/v1/cards?q=a', { headers: h }), env)).status, 503);
  withFetch(async () => new Response('{"data":[]}', { status: 200 }));
  const e2 = { ...env, JUSTTCG_API_KEY: 'j' };
  assert.equal((await api.fetch(new Request('https://x/justtcg/v1/cards?q=a', { headers: h }), e2)).status, 200);
  assert.equal((await api.fetch(new Request('https://x/justtcg/v1/admin', { headers: h }), e2)).status, 404);
});
test('CORS only for the listed web origin', async () => {
  const ok = await api.fetch(new Request('https://x/health', { headers: { origin: 'https://app.lostpokecenter.com' } }), env);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.lostpokecenter.com');
  const bad = await api.fetch(new Request('https://x/health', { headers: { origin: 'https://evil.example' } }), env);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

// ---- PriceCharting prices ----
class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(k, v, o) { this.m.set(k, { v, meta: o?.customMetadata }); }
  async get(k) { const e = this.m.get(k); return e ? { body: e.v } : null; }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
  async list({ prefix = '' } = {}) { return { truncated: false, objects: [...this.m].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, customMetadata: e.meta })) }; }
}
const pcEnv = () => ({ ...env, IMPORT_TOKEN: 'imp', PRICES: new FakeR2() });
const pcFile = (o = {}) => ({ v: 1, game: 'lorcana', slug: 'lorcana-test', name: 'Lorcana Test', date: '2026-10-20', items: [{ i: 1, n: 'Elsa #1', l: 159 }], ...o });
const put = (e, f, q = 'game=lorcana&console=lorcana-test', tok = 'imp') =>
  api.fetch(new Request('https://x/prices/pc/import?' + q, { method: 'PUT', headers: { 'x-import-token': tok }, body: JSON.stringify(f) }), e);
const getH = { 'x-app-token': 't' };

test('import needs its own token, and the app token does not work for it', async () => {
  const e = pcEnv();
  assert.equal((await put(e, pcFile(), undefined, 'nope')).status, 401);
  assert.equal((await put(e, pcFile(), undefined, 't')).status, 401);
  assert.equal((await put({ ...e, IMPORT_TOKEN: undefined }, pcFile(), undefined, '')).status, 401);
});
test('import checks the file, then the app can read it back', async () => {
  const e = pcEnv();
  assert.equal((await put(e, pcFile({ items: [] }))).status, 400);
  assert.equal((await put(e, pcFile({ game: 'pokemon' }))).status, 400);
  assert.equal((await put(e, pcFile({ items: [{ i: 1, n: 'x', l: 1.5 }] }))).status, 400);
  assert.equal((await put(e, pcFile(), 'game=nope&console=lorcana-test')).status, 400);
  assert.equal((await put(e, pcFile(), 'game=lorcana&console=../x')).status, 400);
  assert.equal((await put(e, pcFile())).status, 200);
  const list = await (await api.fetch(new Request('https://x/prices/pc/consoles?game=lorcana', { headers: getH }), e)).json();
  assert.deepEqual(list.sets, [{ slug: 'lorcana-test', name: 'Lorcana Test', date: '2026-10-20', count: 1 }]);
  const set = await api.fetch(new Request('https://x/prices/pc/set?game=lorcana&console=lorcana-test', { headers: getH }), e);
  assert.equal((await set.json()).items[0].l, 159);
  assert.equal((await api.fetch(new Request('https://x/prices/pc/set?game=lorcana&console=missing', { headers: getH }), e)).status, 404);
  assert.equal((await api.fetch(new Request('https://x/prices/pc/set?game=lorcana&console=lorcana-test'), e)).status, 401);
  const st = await (await api.fetch(new Request('https://x/prices/status', { headers: getH }), e)).json();
  assert.deepEqual(st.games, { lorcana: { sets: 1, updated: '2026-10-20' } });
});
test('purge removes every stored price', async () => {
  const e = pcEnv();
  await put(e, pcFile());
  assert.equal((await api.fetch(new Request('https://x/prices/pc/all', { method: 'DELETE', headers: getH }), e)).status, 401);
  const r = await api.fetch(new Request('https://x/prices/pc/all', { method: 'DELETE', headers: { 'x-import-token': 'imp' } }), e);
  assert.equal((await r.json()).removed, 1);
  assert.equal(e.PRICES.m.size, 0);
});
test('without storage the price routes say so', async () => {
  const r = await api.fetch(new Request('https://x/prices/pc/consoles?game=lorcana', { headers: getH }), env);
  assert.equal(r.status, 503);
});

test('history shards: stored by the job, read by the job and the app, and purged with everything else', async () => {
  const e = pcEnv();
  const q = 'game=lorcana&console=lorcana-test&shard=1';
  const body = '{"v":1,"items":{"7":[[2100,159]]}}';
  const putH = (tok, b = body, query = q) => api.fetch(new Request('https://x/prices/pc/hist?' + query, { method: 'PUT', headers: { 'x-import-token': tok }, body: b }), e);
  assert.equal((await putH('nope')).status, 401);
  assert.equal((await putH('imp', 'not json')).status, 400);
  assert.equal((await putH('imp', body, 'game=lorcana&console=lorcana-test&shard=9')).status, 400);
  assert.equal((await putH('imp')).status, 200);
  const byJob = await api.fetch(new Request('https://x/prices/pc/hist?' + q, { headers: { 'x-import-token': 'imp' } }), e);
  assert.equal(await byJob.text(), body);
  const byApp = await api.fetch(new Request('https://x/prices/pc/hist?' + q, { headers: getH }), e);
  assert.equal((await byApp.json()).items['7'][0][1], 159);
  assert.equal((await api.fetch(new Request('https://x/prices/pc/hist?' + q), e)).status, 401);
  assert.equal((await api.fetch(new Request('https://x/prices/pc/hist?game=lorcana&console=lorcana-test&shard=2', { headers: getH }), e)).status, 404);
  const gone = await api.fetch(new Request('https://x/prices/pc/all', { method: 'DELETE', headers: { 'x-import-token': 'imp' } }), e);
  assert.equal((await gone.json()).removed, 1);
});

// ---- pictures ----
const imgEnv = () => ({ ...env, IMPORT_TOKEN: 'imp', IMAGES: new FakeR2() });
const putImg = (e, path, body = new Uint8Array([1, 2, 3]), tok = 'imp') => api.fetch(new Request('https://x' + path, { method: 'PUT', headers: { 'x-import-token': tok }, body }), e);
test('pictures: need the job token, a known game and a plain file name', async () => {
  const e = imgEnv();
  assert.equal((await putImg(e, '/img/yugioh/5000.jpg', undefined, 'no')).status, 401);
  assert.equal((await putImg(e, '/img/yugioh/5000.jpg', undefined, 't')).status, 401);
  assert.equal((await putImg(e, '/img/nope/5000.jpg')).status, 400);
  assert.equal((await putImg(e, '/img/yugioh/..%2Fx.jpg')).status, 400);
  assert.equal((await putImg(e, '/img/yugioh/evil.exe')).status, 400);
  assert.equal((await putImg(e, '/img/yugioh/5000.jpg', new Uint8Array(0))).status, 400);
  assert.equal((await putImg(e, '/img/yugioh/5000.jpg', new Uint8Array(3 * 1024 * 1024))).status, 413);
  assert.equal((await putImg({ ...e, IMAGES: undefined }, '/img/yugioh/5000.jpg')).status, 503);
});
test('pictures: stored, then listed so the job can skip them', async () => {
  const e = imgEnv();
  assert.equal((await putImg(e, '/img/yugioh/5000.jpg')).status, 200);
  assert.equal((await putImg(e, '/img/yugioh/6000.png')).status, 200);
  assert.equal((await putImg(e, '/img/lorcana/1.jpg')).status, 200);
  const r = await api.fetch(new Request('https://x/img/list?game=yugioh', { headers: { 'x-import-token': 'imp' } }), e);
  assert.deepEqual((await r.json()).names.sort(), ['5000.jpg', '6000.png']);
  assert.equal((await api.fetch(new Request('https://x/img/list?game=yugioh', { headers: { 'x-app-token': 't' } }), e)).status, 401);
});
