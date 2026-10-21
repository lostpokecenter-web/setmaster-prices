// Card-recognition proxy using Google's Gemini API (free tier).
// Env: GEMINI_API_KEY (required), APP_TOKEN (required), MODEL (optional, default below).

const DEFAULT_MODEL = 'gemini-3.7-flash';
// A hung model must fail fast so the proxy can switch to the fallback inside the app's 45s limit.
const UPSTREAM_TIMEOUT_MS = 20_000;

// Reading a card is OCR, not reasoning, so extended thinking only costs latency here.
// Model families spell this differently, so an unsupported field is detected once and then dropped.
const THINKING_LEVEL = 'low'; // 'off' disables this entirely
let thinkingField = THINKING_LEVEL === 'off' ? null : 'thinkingLevel';

function buildBody(mediaType, imageBase64) {
  const generationConfig = { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 2048 };
  if (thinkingField === 'thinkingLevel') generationConfig.thinkingLevel = THINKING_LEVEL;
  else if (thinkingField === 'thinkingConfig') generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mediaType, data: imageBase64 } },
        { text: 'Identify this card.' },
      ],
    }],
    generationConfig,
  });
}

/** 400s caused by the thinking field are recoverable: step down to the next spelling and retry. */
function downgradeThinking() {
  if (!thinkingField) return false;
  // Gemini often words this only as "Request contains an invalid argument", so any 400 counts while a thinking field is being sent.
  thinkingField = thinkingField === 'thinkingLevel' ? 'thinkingConfig' : null;
  console.log(`Gemini rejected the thinking setting; retrying with ${thinkingField ?? 'the model default'}.`);
  return true;
}

const SYSTEM = `You identify trading cards from a single photo. Reply with ONLY a JSON object, no prose, no code fences.
Keys:
- game: "pokemon" | "mtg" | "yugioh" | "lorcana" | "onepiece" | "digimon" | "fab" (Flesh and Blood) | "swu" (Star Wars: Unlimited) | "dragonball" (Dragon Ball Super Fusion World) | "riftbound" | "gundam" | "sports" | "unknown"
- card_name: full printed name including suffixes (ex, V, VMAX, GX). Lorcana: "Name - Subtitle". Sports: player name.
- card_number: exactly as printed (e.g. "277/217", "LOB-EN001", "BT1-001", "OP01-001", "FB01-001", "WTR001", "42/204"). Magic: the collector number only (e.g. "277" from "0277/0303"). Sports: the card number.
- set_name: only if printed on the card or you are certain, else null
- set_code: printed set code/abbreviation (e.g. "MEG", "LOB", "BT1", "OP01"). Magic: the 3-5 letter set code printed bottom-left (e.g. "MH3"). Sports: "<year> <brand>".
- rarity: if visible or certain, else null
- language: "English", "Japanese", etc., judged from the card text
- variant: one of "Normal", "Holo", "Reverse Holo", "Foil", "Cold Foil", "1st Edition", "Promo"
- is_graded: true if the card is in a grading slab
- grading_company: the slab's company as printed, e.g. "PSA", "CGC", "BGS", "SGC", "TAG", else null
- grade: the numeric grade from the slab label, else null. Keep a named top grade only for these: a CGC, SGC or TAG slab that says "Pristine" stays "Pristine 10", and a BGS slab with a black label (a black label background) is "Black Label 10". Everything else that is a 10 is plain "10": "Gem Mint 10" on CGC or SGC, and "Pristine 10" on a normal gold-label BGS slab (that is BGS's ordinary 10).
- confidence: 0 to 1 for how sure you are of card_name and card_number
Use null for anything you cannot read. Never invent a number you cannot see.`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const fail = (status, message, extra = {}) => json({ error: message, ...extra }, status);

// Status choices matter to the app: 429 and 5xx (and 401/403) pause scanning and keep the
// photo queued; other 4xx count as a failed read of that one card.
function upstreamError(status, raw, model) {
  let detail = raw.slice(0, 500);
  try { detail = JSON.parse(raw)?.error?.message ?? detail; } catch { /* keep raw text */ }
  console.error(`Gemini API error ${status}: ${detail}`);

  if (status === 429) {
    return fail(429, 'Gemini free-tier rate limit reached. Wait a minute and try again. The free tier also has a daily cap.', { upstream_status: 429 });
  }
  if (status === 400 && /api key/i.test(detail)) {
    return fail(503, 'Gemini rejected the API key. Check that GEMINI_API_KEY is correct and restart the server.', { upstream_status: 400 });
  }
  if (status === 401 || status === 403) {
    return fail(503, 'Gemini denied access. The key may be invalid, or the free tier may not be available in your region.', { upstream_status: status });
  }
  if (status === 404) {
    return fail(502, `Gemini model "${model}" was not found. Set the MODEL environment variable to a model your key can use.`, { upstream_status: 404 });
  }
  if (status === 400) {
    return fail(422, `Gemini could not process this image: ${detail}`, { upstream_status: 400 });
  }
  return fail(502, `Gemini API error (${status}). Check the Termux console for details.`, { upstream_status: status });
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return fail(405, 'method not allowed');
    if (!env.APP_TOKEN || req.headers.get('x-app-token') !== env.APP_TOKEN) return fail(401, 'unauthorized');
    if (!env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set.');
      return fail(500, 'The server is missing GEMINI_API_KEY. Export it and restart the server.');
    }

    let body;
    try { body = await req.json(); } catch { return fail(400, 'bad json'); }
    const { imageBase64, mediaType = 'image/jpeg' } = body ?? {};
    if (!imageBase64 || imageBase64.length > 4_000_000) return fail(400, 'image missing or too large');

    const model = env.MODEL || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    let upstream;
    let raw;
    for (let attempt = 0; ; attempt++) {
      try {
        upstream = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
          body: buildBody(mediaType, imageBase64),
        });
      } catch (e) {
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        console.error('Gemini request failed:', timedOut ? `timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s` : e);
        return timedOut
          ? fail(504, 'Gemini took too long to respond. Try again.')
          : fail(502, "Could not reach the Gemini API. Check the phone's internet connection.");
      }
      raw = await upstream.text();
      if (upstream.status === 400 && attempt < 2 && downgradeThinking()) continue;
      break;
    }
    if (!upstream.ok) return upstreamError(upstream.status, raw, model);

    let data;
    try { data = JSON.parse(raw); } catch {
      console.error('Gemini returned a non-JSON body:', raw.slice(0, 300));
      return fail(502, 'Gemini returned an unreadable response.');
    }

    const cand = data.candidates?.[0];
    if (!cand) {
      console.error('Gemini returned no candidates:', JSON.stringify(data.promptFeedback ?? data).slice(0, 300));
      const reason = data.promptFeedback?.blockReason;
      return fail(422, reason ? `Gemini blocked this image (${reason}).` : 'Gemini returned no answer for this image.');
    }

    const text = (cand.content?.parts ?? [])
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    try {
      let parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      if (Array.isArray(parsed)) parsed = parsed[0];
      if (parsed && typeof parsed === 'object') return json(parsed); // same shape the app already expects
    } catch { /* fall through */ }

    console.error(`Unparseable model output (finishReason=${cand.finishReason}):`, text.slice(0, 300));
    return fail(422, 'Gemini returned an answer that could not be read as card data. Try rescanning.');
  },
};
