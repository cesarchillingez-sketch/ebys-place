/**
 * Eby's Place — AI Try-On Cloudflare Worker
 *
 * Routes:
 *   POST /api/tryon          — Submit a new try-on job
 *   GET  /api/tryon/:jobId   — Poll job status / retrieve result URL
 *
 * Pipeline (2-stage, exact face preservation):
 *   Stage 1 — jonathandinu/face-parsing
 *     Segments the uploaded photo and returns a hair-region mask URL.
 *   Stage 2 — black-forest-labs/flux-fill-pro
 *     Inpaints only the masked hair region; face pixels are untouched by design.
 *
 * Required Worker secrets (set via `wrangler secret put`):
 *   REPLICATE_API_KEY  — Your Replicate API token
 *
 * Required Worker KV namespace bindings (wrangler.toml):
 *   RATE_LIMITER  — KV namespace for IP rate limiting
 *   JOB_STATE     — KV namespace for per-job pipeline state
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Domains allowed to call this API.  GitHub Pages sub-domain is included. */
const ALLOWED_ORIGINS = [
  'https://ebysplace.com',
  'https://www.ebysplace.com',
];

// ---------------------------------------------------------------------------
// Stage 1 — hair segmentation (face-parsing)
// ---------------------------------------------------------------------------
/** Replicate model that returns a hair-region segmentation mask. */
const STAGE1_MODEL_OWNER = 'jonathandinu';
const STAGE1_MODEL_NAME  = 'face-parsing';

// ---------------------------------------------------------------------------
// Stage 2 — hair inpainting
// ---------------------------------------------------------------------------
/**
 * FLUX Fill Pro inpaints only the masked (hair) region.
 * Because the face sits outside the mask, it is preserved pixel-perfectly.
 */
const STAGE2_MODEL_OWNER = 'black-forest-labs';
const STAGE2_MODEL_NAME  = 'flux-fill-pro';

/**
 * Rate limiting — requests per window per IP.
 * Requires a KV namespace called RATE_LIMITER bound in wrangler.toml.
 * If the binding is absent the check is silently skipped (no KV = no limiting).
 */
const RATE_LIMIT_REQUESTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

/** TTL for per-job pipeline state stored in JOB_STATE KV (1 hour). */
const JOB_STATE_TTL_SECONDS = 3600;

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

  // 5. Stage 1 — hair segmentation via face-parsing
  let prediction;
  try {
    prediction = await replicateStage1(env.REPLICATE_API_KEY, dataUrl);
  } catch (err) {
    console.error('[tryon] Stage-1 submit error:', err.message);
    return jsonResponse(
      { error: 'Failed to start generation. Please try again shortly.' },
      502, corsHeaders,
    );
  }

  // 6. Persist job state so the poll handler can advance to stage 2
  //    when stage 1 completes.  JOB_STATE KV must be bound in wrangler.toml;
  //    without it the pipeline cannot advance beyond stage 1.
  if (!env.JOB_STATE) {
    console.error('[tryon] JOB_STATE KV binding is missing — 2-stage pipeline requires it.');
    return jsonResponse(
      { error: 'Service misconfiguration. Please contact support.' },
      500, corsHeaders,
    );
  }

  const inpaintPrompt = buildInpaintPrompt(prompt);
  await env.JOB_STATE.put(
    `job:${prediction.id}`,
    JSON.stringify({ stage: 1, originalImage: dataUrl, prompt: inpaintPrompt }),
    { expirationTtl: JOB_STATE_TTL_SECONDS },
  );

  console.log(`[tryon] Stage-1 job ${prediction.id} submitted — style: ${styleName}, ip: ${ip}`);

  return jsonResponse(
    { jobId: prediction.id, status: prediction.status, stage: 1 },
    202, corsHeaders,
  );
}

async function handlePoll(jobId, env, corsHeaders) {
  // ------------------------------------------------------------------
  // Look up whether this jobId belongs to a tracked pipeline stage.
  // If JOB_STATE KV is not bound, behave as a simple Replicate poll.
  // ------------------------------------------------------------------
  let jobState = null;
  if (env.JOB_STATE) {
    const raw = await env.JOB_STATE.get(`job:${jobId}`);
    if (raw) {
      try { jobState = JSON.parse(raw); } catch { /* ignore malformed */ }
    }
  }

  // Fetch current prediction status from Replicate
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

  const { status } = prediction;

  // ------------------------------------------------------------------
  // Stage 1 complete → submit stage 2 (inpainting)
  // ------------------------------------------------------------------
  if (jobState?.stage === 1 && status === 'succeeded') {
    const maskUrl = extractOutputUrl(prediction.output);
    if (!maskUrl) {
      return jsonResponse({ error: 'Hair segmentation returned no mask.' }, 502, corsHeaders);
    }

    let stage2Prediction;
    try {
      stage2Prediction = await replicateStage2(
        env.REPLICATE_API_KEY,
        jobState.originalImage,
        maskUrl,
        jobState.prompt,
      );
    } catch (err) {
      console.error(`[tryon] Stage-2 submit error for ${jobId}:`, err.message);
      return jsonResponse(
        { error: 'Failed to start inpainting. Please try again shortly.' },
        502, corsHeaders,
      );
    }

    // Clean up stage-1 state; no need to track stage-2 separately
    await env.JOB_STATE.delete(`job:${jobId}`).catch(err =>
      console.warn(`[tryon] Failed to delete KV entry for ${jobId}:`, err.message),
    );

    console.log(`[tryon] Stage-2 job ${stage2Prediction.id} submitted (from stage-1 ${jobId})`);

    // Tell the client to start polling the new stage-2 job ID
    return jsonResponse(
      { status: 'processing', stage: 2, jobId: stage2Prediction.id },
      200, corsHeaders,
    );
  }

  // ------------------------------------------------------------------
  // Stage 1 still running, or plain stage-2 / legacy job
  // ------------------------------------------------------------------
  const body = { status };
  if (jobState?.stage === 1) body.stage = 1;

  if (status === 'succeeded') {
    const url = extractOutputUrl(prediction.output);
    if (!url) {
      return jsonResponse({ error: 'AI returned no image.' }, 502, corsHeaders);
    }
    body.url = url;
    console.log(`[tryon] Job ${jobId} succeeded — url: ${url}`);
  } else if (status === 'failed' || status === 'canceled') {
    body.error = prediction.error || 'Generation failed. Please try again.';
    console.warn(`[tryon] Job ${jobId} failed:`, prediction.error);
  }

  return jsonResponse(body, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Extract a result URL from model output (handles string or array)
// ---------------------------------------------------------------------------
function extractOutputUrl(output) {
  if (!output) return null;
  if (Array.isArray(output)) return output[0] || null;
  if (typeof output === 'string') return output;
  return null;
}

// ---------------------------------------------------------------------------
// Replicate helpers — 2-stage pipeline
// ---------------------------------------------------------------------------

/**
 * Stage 1 — Submit to jonathandinu/face-parsing.
 * The model returns a segmented image where the hair region is coloured
 * distinctly (CelebAMask-HQ label 17).  We use that image directly as the
 * inpainting mask in stage 2 — FLUX Fill Pro treats any non-black region
 * in the mask as the area to inpaint, so the coloured hair segment drives
 * the edit while the face is untouched.
 */
async function replicateStage1(apiKey, imageDataUrl) {
  const resp = await fetch(
    `https://api.replicate.com/v1/models/${STAGE1_MODEL_OWNER}/${STAGE1_MODEL_NAME}/predictions`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'respond-async',
      },
      body: JSON.stringify({
        input: { image: imageDataUrl },
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Replicate stage-1 ${resp.status}: ${body}`);
  }

  return resp.json();
}

/**
 * Stage 2 — Submit to black-forest-labs/flux-fill-pro.
 * Inpaints only the masked hair region; face pixels are structurally
 * preserved because they lie outside the mask.
 */
async function replicateStage2(apiKey, imageDataUrl, maskUrl, prompt) {
  const resp = await fetch(
    `https://api.replicate.com/v1/models/${STAGE2_MODEL_OWNER}/${STAGE2_MODEL_NAME}/predictions`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'respond-async',
      },
      body: JSON.stringify({
        input: {
          image:          imageDataUrl,
          mask:           maskUrl,
          prompt:         prompt,
          output_format:  'jpg',
          output_quality: 90,
          safety_tolerance: 2,
        },
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Replicate stage-2 ${resp.status}: ${body}`);
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
 * Build an inpainting prompt for FLUX Fill Pro (stage 2).
 * The prompt describes only the hair since the face is structurally preserved
 * by the mask — the model only generates pixels inside the masked region.
 */
function buildInpaintPrompt(stylePrompt) {
  return `${stylePrompt}, professional braiding salon quality, natural realistic look, high resolution`;
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

/** Serialize data as JSON and attach CORS / content-type headers. */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...extraHeaders, 'Content-Type': 'application/json' },
  });
}
