// Deploys the Worker with Cloudflare's web API, for machines where Wrangler cannot run (such as Termux).
//   CLOUDFLARE_API_TOKEN   required
//   GEMINI_API_KEY, APP_TOKEN, IMPORT_TOKEN, JUSTTCG_API_KEY   secrets; leave one unset to keep the value already on the Worker
//   CLOUDFLARE_ACCOUNT_ID  optional (found from the token when not set)
//   node deploy.mjs --dry-run   shows what would be sent, without calling Cloudflare
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'setmaster-api';
const HOST = 'api.lostpokecenter.com';
const ZONE = 'lostpokecenter.com';
const BUCKET = 'setmaster-prices';
const IMAGES_BUCKET = 'setmaster-images';
const API = 'https://api.cloudflare.com/client/v4';
const dry = process.argv.includes('--dry-run');
const env = process.env;

const vars = { MODEL: 'gemini-3.7-flash', ALLOWED_ORIGINS: 'https://app.lostpokecenter.com', ...(env.FALLBACK_MODEL ? { FALLBACK_MODEL: env.FALLBACK_MODEL } : {}) };
const secrets = ['GEMINI_API_KEY', 'APP_TOKEN', 'IMPORT_TOKEN', 'JUSTTCG_API_KEY'].filter((k) => env[k]);

export function buildMetadata() {
  return {
    main_module: 'index.mjs',
    compatibility_date: '2026-01-01',
    bindings: [
      ...Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
      ...secrets.map((name) => ({ type: 'secret_text', name, text: env[name] })),
      { type: 'r2_bucket', name: 'PRICES', bucket_name: BUCKET },
      { type: 'r2_bucket', name: 'IMAGES', bucket_name: IMAGES_BUCKET },
      { type: 'ratelimit', name: 'LIMITER', namespace_id: '1001', simple: { limit: 60, period: 60 } },
    ],
    keep_bindings: ['secret_text'], // secrets not given this time stay as they are
  };
}

async function call(token, method, url, body, headers = {}) {
  const res = await fetch(API + url, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = (data.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(`${method} ${url.split('?')[0]} failed: ${msg}`);
  }
  return data.result;
}

async function main() {
  const meta = buildMetadata();
  if (dry) {
    const shown = { ...meta, bindings: meta.bindings.map((b) => (b.type === 'secret_text' ? { ...b, text: '(hidden)' } : b)) };
    console.log('Would upload index.mjs, scan.mjs and prices.mjs as', NAME, '\n' + JSON.stringify(shown, null, 2), '\nand attach', HOST);
    return;
  }
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN first.');
  let account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const accts = await call(token, 'GET', '/accounts');
    if (accts.length !== 1) throw new Error(`The token can see ${accts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID to the one to use (dashboard, Workers & Pages, right-hand side).`);
    account = accts[0].id;
  }
  try { // the picture storage, same way
    await call(token, 'POST', `/accounts/${account}/r2/buckets`, JSON.stringify({ name: IMAGES_BUCKET }), { 'content-type': 'application/json' });
    console.log(`Created storage bucket ${IMAGES_BUCKET}.`);
  } catch (e) {
    if (!/already exists|10004|409/i.test(e.message)) console.log(`Note: could not create the bucket ${IMAGES_BUCKET} (${e.message}). Create it in the dashboard: R2 object storage > Create bucket > name ${IMAGES_BUCKET}. Continuing.`);
  }
  try { // the price storage; already existing is fine. Without the R2 permission, create the bucket by hand in the dashboard.
    await call(token, 'POST', `/accounts/${account}/r2/buckets`, JSON.stringify({ name: BUCKET }), { 'content-type': 'application/json' });
    console.log(`Created storage bucket ${BUCKET}.`);
  } catch (e) {
    if (!/already exists|10004|409/i.test(e.message)) console.log(`Note: could not create the bucket ${BUCKET} (${e.message}). If it does not exist yet, create it in the dashboard: R2 object storage > Create bucket > name ${BUCKET}. Continuing.`);
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  for (const f of ['index.mjs', 'scan.mjs', 'prices.mjs', 'images.mjs']) form.append(f, new Blob([await fs.readFile(path.join(HERE, f))], { type: 'application/javascript+module' }), f);
  await call(token, 'PUT', `/accounts/${account}/workers/scripts/${NAME}`, form);
  console.log(`Uploaded ${NAME}. Secrets sent this time: ${secrets.join(', ') || 'none (kept the existing ones)'}.`);

  const zones = await call(token, 'GET', `/zones?name=${ZONE}&account.id=${account}`);
  if (!zones.length) throw new Error(`${ZONE} was not found on this account.`);
  await call(token, 'PUT', `/accounts/${account}/workers/domains`, JSON.stringify({ hostname: HOST, service: NAME, zone_id: zones[0].id, environment: 'production' }), { 'content-type': 'application/json' });
  console.log(`Attached ${HOST}. Check https://${HOST}/health in a minute (the certificate can take a short while).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('Deploy failed:', e.message); process.exit(1); });
