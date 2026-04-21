/**
 * Eby's Place — AI Try-On Cloudflare Worker
 *
 * Routes:
 *   POST /api/tryon          — Submit a new try-on job
 *   GET  /api/tryon/:jobId   — Poll job status / retrieve result URL
 *
 * Required Worker secrets (set via `wrangler secret put`):
 *   REPLICATE_API_KEY  — Your Replicate API token
 *
 * Optional Worker KV namespace binding (for rate limiting):
 *   RATE_LIMITER  — A KV namespace bound in wrangler.toml
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Domains allowed to call this API.  GitHub Pages sub-domain is included. */
const ALLOWED_ORIGINS = [
  'https://ebysplace.com',
  'https://www.ebysplace.com',
];

/** Replicate model used for instruction-based image editing (hair style swap). */
const REPLICATE_MODEL_OWNER = 'timothybrooks';
const REPLICATE_MODEL_NAME  = 'instruct-pix2pix';

/**
 * Rate limiting — requests per window per IP.
 * Requires a KV namespace called RATE_LIMITER bound in wrangler.toml.
 * If the binding is absent the check is silently skipped (no KV = no limiting).
 */
const RATE_LIMIT_REQUESTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    const corsHeaders = buildCorsHeaders(origin);

    // Pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // POST /api/tryon — submit
    if (request.method === 'POST' && url.pathname === '/api/tryon') {
      return handleSubmit(request, env, corsHeaders);
    }

    // GET /api/tryon/:jobId — poll
    const pollMatch = url.pathname.match(/^\/api\/tryon\/([\w-]+)$/);
    if (request.method === 'GET' && pollMatch) {
      return handlePoll(pollMatch[1], env, corsHeaders);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSubmit(request, env, corsHeaders) {
  // 1. Rate limiting
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await checkRateLimit(env, ip);
  if (!allowed) {
    return jsonResponse(
      { error: 'Too many requests — please wait a minute and try again.' },
      429, corsHeaders,
    );
  }

  // 2. Parse multipart form data
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'Invalid request format.' }, 400, corsHeaders);
  }

  const photo     = formData.get('photo');
  const style     = formData.get('style');
  const prompt    = formData.get('prompt');
  const styleName = formData.get('styleName') || style;

  if (!photo || !style || !prompt) {
    return jsonResponse(
      { error: 'Missing required fields: photo, style, prompt.' },
      400, corsHeaders,
    );
  }

  // 3. Validate image
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  if (!ALLOWED_TYPES.includes(photo.type)) {
    return jsonResponse(
      { error: 'Invalid image type. Please upload a JPG, PNG, or WEBP file.' },
      400, corsHeaders,
    );
  }

  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB (client already compresses to ~1 MB)
  if (photo.size > MAX_BYTES) {
    return jsonResponse(
      { error: 'Image is too large. Please upload an image under 10 MB.' },
      400, corsHeaders,
    );
  }

  // 4. Convert image to base64 data URL (Replicate accepts this format)
  const buffer  = await photo.arrayBuffer();
  const base64  = arrayBufferToBase64(buffer);
  const dataUrl = `data:${photo.type};base64,${base64}`;

  // 5. Build a face-preserving prompt
  const fullPrompt = buildPrompt(prompt);

  // 6. Submit to Replicate
  let prediction;
  try {
    prediction = await replicateSubmit(env.REPLICATE_API_KEY, dataUrl, fullPrompt);
  } catch (err) {
    console.error('[tryon] Replicate submit error:', err.message);
    return jsonResponse(
      { error: 'Failed to start generation. Please try again shortly.' },
      502, corsHeaders,
    );
  }

  console.log(`[tryon] Job ${prediction.id} submitted — style: ${styleName}, ip: ${ip}`);

  return jsonResponse(
    { jobId: prediction.id, status: prediction.status },
    202, corsHeaders,
  );
}

async function handlePoll(jobId, env, corsHeaders) {
  let prediction;
  try {
    prediction = await replicatePoll(env.REPLICATE_API_KEY, jobId);
  } catch (err) {
    console.error(`[tryon] Poll error for ${jobId}:`, err.message);
    return jsonResponse(
      { error: 'Failed to check job status. Please try again.' },
      502, corsHeaders,
    );
  }

  const body = { status: prediction.status };

  if (prediction.status === 'succeeded') {
    const raw = prediction.output;
    const url = Array.isArray(raw) ? raw[0] : raw;
    if (!url) {
      return jsonResponse({ error: 'AI returned no image.' }, 502, corsHeaders);
    }
    body.url = url;
    console.log(`[tryon] Job ${jobId} succeeded — url: ${url}`);
  } else if (prediction.status === 'failed' || prediction.status === 'canceled') {
    body.error = prediction.error || 'Generation failed. Please try again.';
    console.warn(`[tryon] Job ${jobId} failed:`, prediction.error);
  }

  return jsonResponse(body, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Replicate helpers
// ---------------------------------------------------------------------------

/**
 * Submit a new prediction to the latest version of the model.
 * Uses /v1/models/:owner/:name/predictions so no version hash is needed.
 */
async function replicateSubmit(apiKey, imageDataUrl, prompt) {
  const resp = await fetch(
    `https://api.replicate.com/v1/models/${REPLICATE_MODEL_OWNER}/${REPLICATE_MODEL_NAME}/predictions`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'respond-async',
      },
      body: JSON.stringify({
        input: {
          image:               imageDataUrl,
          prompt:              prompt,
          negative_prompt:     'changed face, different person, altered eyes, altered nose, altered mouth, altered skin tone, altered expression, blurry face, distorted face, deformed face, low quality, ugly',
          image_guidance_scale: 2.5,
          guidance_scale:       7.5,
          num_inference_steps:  50,
          num_outputs:          1,
        },
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Replicate ${resp.status}: ${body}`);
  }

  return resp.json();
}

/** Fetch the current status of a Replicate prediction. */
async function replicatePoll(apiKey, predictionId) {
  const resp = await fetch(
    `https://api.replicate.com/v1/predictions/${predictionId}`,
    { headers: { 'Authorization': `Token ${apiKey}` } },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Replicate ${resp.status}: ${body}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Rate limiting (Cloudflare KV)
// ---------------------------------------------------------------------------

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMITER) return true; // KV not bound — skip

  const key     = `rl:${ip}`;
  const current = await env.RATE_LIMITER.get(key);
  const count   = current ? parseInt(current, 10) : 0;

  if (count >= RATE_LIMIT_REQUESTS) return false;

  await env.RATE_LIMITER.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });

  return true;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Build CORS headers.  Accepts exact matches + any *.github.io sub-domain. */
function buildCorsHeaders(origin) {
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-zA-Z0-9-]+\.github\.io$/.test(origin);

  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

/**
 * Build a hair-only instruction prompt for instruct-pix2pix.
 * The model responds to short imperative phrases. A high image_guidance_scale (2.5)
 * combined with explicit "do not change" wording keeps the face, skin, and
 * background identical and restricts changes to the hair region only.
 */
function buildPrompt(stylePrompt) {
  return `Replace only the hairstyle with ${stylePrompt}. Keep the person's face, eyes, nose, mouth, skin tone, expression, neck, shoulders, clothing, and background completely identical. Do not change anything except the hair.`;
}

/** Convert an ArrayBuffer to a base64 string without Buffer (Workers runtime). */
function arrayBufferToBase64(buffer) {
  const bytes  = new Uint8Array(buffer);
  let   binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Chunk size for String.fromCharCode in arrayBufferToBase64.
 *  Kept below the JS call-stack argument limit to avoid "Maximum call stack size exceeded". */
const BASE64_CHUNK_SIZE = 0x8000; // 32 768 bytes
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...extraHeaders, 'Content-Type': 'application/json' },
  });
}
