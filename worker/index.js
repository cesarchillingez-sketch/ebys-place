/**
 * Eby's Place — AI Try-On Cloudflare Worker
 *
 * Routes:
 *   POST /api/tryon          — Submit stage 1 (hair segmentation)
 *   POST /api/tryon/inpaint  — Submit stage 2 (hair inpainting) with mask from stage 1
 *   GET  /api/tryon/:jobId   — Poll any Replicate job for its current status
 *
 * Pipeline (2-stage, exact face preservation):
 *   Stage 1 — jonathandinu/face-parsing
 *     Segments the uploaded photo and returns a hair-region mask URL.
 *   Stage 2 — black-forest-labs/flux-fill-pro
 *     Inpaints only the masked hair region; face pixels are untouched by design.
 *
 * Pipeline state is tracked client-side, so no KV namespaces are required.
 *
 * Required Worker secret (set via `wrangler secret put`):
 *   REPLICATE_API_KEY  — Your Replicate API token
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Domains allowed to call this API. */
const ALLOWED_ORIGINS = [
  'https://ebysplace.com',
  'https://www.ebysplace.com',
];

const STAGE1_MODEL_OWNER = 'jonathandinu';
const STAGE1_MODEL_NAME  = 'face-parsing';

const STAGE2_MODEL_OWNER = 'black-forest-labs';
const STAGE2_MODEL_NAME  = 'flux-fill-pro';

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

    // POST /api/tryon — submit stage 1
    if (request.method === 'POST' && url.pathname === '/api/tryon') {
      return handleSubmit(request, env, corsHeaders);
    }

    // POST /api/tryon/inpaint — submit stage 2 using mask from stage 1
    if (request.method === 'POST' && url.pathname === '/api/tryon/inpaint') {
      return handleInpaint(request, env, corsHeaders);
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
  if (!env.REPLICATE_API_KEY) {
    console.error('[tryon] REPLICATE_API_KEY secret is not set.');
    return jsonResponse(
      { error: 'Service misconfiguration. Please contact support.' },
      500, corsHeaders,
    );
  }

  // Parse multipart form data
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

  // Validate image
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

  // Convert image to base64 data URL (Replicate accepts this format)
  const buffer  = await photo.arrayBuffer();
  const base64  = arrayBufferToBase64(buffer);
  const dataUrl = `data:${photo.type};base64,${base64}`;

  // Submit to Stage 1 — hair segmentation via face-parsing
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

  const inpaintPrompt = buildInpaintPrompt(prompt);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  console.log(`[tryon] Stage-1 job ${prediction.id} submitted — style: ${styleName}, ip: ${ip}`);

  // Return jobId + the inpaint prompt so the client can submit stage 2 itself
  return jsonResponse(
    { jobId: prediction.id, status: prediction.status, stage: 1, prompt: inpaintPrompt },
    202, corsHeaders,
  );
}

async function handleInpaint(request, env, corsHeaders) {
  if (!env.REPLICATE_API_KEY) {
    console.error('[tryon] REPLICATE_API_KEY secret is not set.');
    return jsonResponse(
      { error: 'Service misconfiguration. Please contact support.' },
      500, corsHeaders,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request format.' }, 400, corsHeaders);
  }

  const { image, mask, prompt } = body;
  if (!image || !mask || !prompt) {
    return jsonResponse(
      { error: 'Missing required fields: image, mask, prompt.' },
      400, corsHeaders,
    );
  }

  let prediction;
  try {
    prediction = await replicateStage2(env.REPLICATE_API_KEY, image, mask, prompt);
  } catch (err) {
    console.error('[tryon] Stage-2 submit error:', err.message);
    return jsonResponse(
      { error: 'Failed to start inpainting. Please try again shortly.' },
      502, corsHeaders,
    );
  }

  console.log(`[tryon] Stage-2 job ${prediction.id} submitted`);
  return jsonResponse(
    { jobId: prediction.id, status: prediction.status, stage: 2 },
    202, corsHeaders,
  );
}

async function handlePoll(jobId, env, corsHeaders) {
  if (!env.REPLICATE_API_KEY) {
    return jsonResponse(
      { error: 'Service misconfiguration. Please contact support.' },
      500, corsHeaders,
    );
  }

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
  const body = { status };

  if (status === 'succeeded') {
    const url = extractOutputUrl(prediction.output);
    if (!url) {
      return jsonResponse({ error: 'AI returned no output.' }, 502, corsHeaders);
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
