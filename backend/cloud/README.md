# SetMaster API (Cloudflare Worker)

The hosted version of the phone proxy, served at **api.lostpokecenter.com**. It keeps your keys off the phone and out of the app.

## What it serves
| Request | What it does |
|---|---|
| `POST /` | Scan a card photo with Gemini. Same request and answer as the phone proxy, with the same retry on overload and fallback model. |
| `GET /justtcg/v1/games`, `/cards` | Forwards to JustTCG with your key kept here (only if you set `JUSTTCG_API_KEY`). |
| `GET /prices/status` | Which games have PriceCharting prices stored, and when they were last updated. |
| `GET /prices/pc/consoles?game=`, `/prices/pc/set?game=&console=` | The stored PriceCharting prices, one small file per set. |
| `PUT /prices/pc/import` | The daily job stores a set (needs `IMPORT_TOKEN`, not the app token). |
| `DELETE /prices/pc/all` | Removes every stored price (needs `IMPORT_TOKEN`). Use within 30 days if the PriceCharting subscription ends. |
| `GET /health` | No token needed. For checking it is up. |

Not hosted on purpose: the offline TCGplayer price mirror and graded prices (`/graded`). Their data is not licensed for a paid app. PriceCharting prices are stored in an R2 bucket (`setmaster-prices`, created by `deploy.mjs`; the API token also needs Account > Workers R2 Storage > Edit).

## Deploy from Termux (no Wrangler)
Wrangler cannot run on Android (it needs the `workerd` runtime). Use `deploy.mjs`, which calls Cloudflare's web API:
```
cd ~/cardvault-app/backend/cloud
read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN; echo; export CLOUDFLARE_API_TOKEN
read -rsp "Gemini key: " GEMINI_API_KEY; echo; export GEMINI_API_KEY
read -rsp "App token: " APP_TOKEN; echo; export APP_TOKEN
read -rsp "Import token (make up a long random one): " IMPORT_TOKEN; echo; export IMPORT_TOKEN
node deploy.mjs
unset CLOUDFLARE_API_TOKEN GEMINI_API_KEY APP_TOKEN IMPORT_TOKEN
```
Token: dashboard > My Profile > API Tokens > Create Token > "Edit Cloudflare Workers" template, with the zone set to lostpokecenter.com. If the domain step is refused, add the permission Zone > DNS > Edit. Secrets left unset keep their existing values. `node deploy.mjs --dry-run` shows what would be sent.

## Deploy with Wrangler (a computer, not Termux)
```
cd ~/cardvault-app/backend/cloud
npm install
npx wrangler login
read -rsp "Gemini key: " K; echo; printf %s "$K" | npx wrangler secret put GEMINI_API_KEY; unset K
read -rsp "App token: " T; echo; printf %s "$T" | npx wrangler secret put APP_TOKEN; unset T
npx wrangler deploy
```
Use a NEW Gemini key (revoke the one pasted in chat earlier). `wrangler deploy` attaches `api.lostpokecenter.com` itself, since the domain is on your Cloudflare account. Check it: open `https://api.lostpokecenter.com/health` in a browser; it should show `{"ok":true}`.

Optional: `npx wrangler secret put JUSTTCG_API_KEY`, and set `FALLBACK_MODEL` in `wrangler.toml`.

## Point the app at it
In the app's `.env`: `EXPO_PUBLIC_PROXY_URL=https://api.lostpokecenter.com` and `EXPO_PUBLIC_APP_TOKEN=<the same token>`.

## Known limits (do these before launch)
- **The app token ships inside the app**, so anyone can extract it. It only keeps casual traffic out. Before launch, require an active subscription (RevenueCat) in `allowed()` in `index.mjs`. The per-IP limit (60 a minute) is a backstop, not protection.
- **Cost:** every scan is billed to your Gemini key. Set a spending cap in Google's console, and use the paid tier (the free tier may not be allowed for a public app; check Google's terms).
- **No shared pacing.** The phone proxy spaced calls to fit the free tier. Workers cannot share that state, so a rate-limited call returns 429 and the app pauses and retries.
- Test: `npm test` (12 tests, no network needed).
