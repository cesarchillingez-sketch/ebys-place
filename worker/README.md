# Eby's Place — AI Try-On Worker

This directory contains a **Cloudflare Worker** that acts as the secure API
backend for the AI Try-On feature on `tryon.html`.

Because `ebysplace.com` is hosted on GitHub Pages (static files only), the
worker runs as a separate edge service and handles everything that requires a
secret key: calling the Replicate AI API, rate limiting requests, and
validating uploaded images.

---

## Architecture — 2-stage pipeline (exact face preservation)

```
Browser (tryon.html)
  │  POST /api/tryon         (multipart: photo + style + prompt)
  │  GET  /api/tryon/:jobId  (poll — client follows stage transitions)
  ▼
Cloudflare Worker  (this directory)
  │
  ├─ Stage 1 ─ jonathandinu/face-parsing
  │            Segments the photo; returns a hair-region mask image URL.
  │            Job state (original image + prompt) stored in JOB_STATE KV.
  │
  └─ Stage 2 ─ black-forest-labs/flux-fill-pro
               Inpaints only the masked hair region.
               Face pixels lie outside the mask → zero AI drift.
```

**Why exact face preservation?**
Previous approach (`instruct-pix2pix`) edited the whole image via text
instructions — the face could drift slightly on every run.  The 2-stage
pipeline uses a structural mask, so the model is physically prevented from
touching any pixel outside the hair region.  The face, eyes, skin tone, and
expression are preserved exactly.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 18 |
| Wrangler (Cloudflare CLI) | ≥ 3 |

```bash
npm install -g wrangler
wrangler login
```

---

## One-time setup

### 1. Create KV namespaces

```bash
wrangler kv namespace create RATE_LIMITER
wrangler kv namespace create JOB_STATE
```

Copy the `id` values from the output and paste them into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMITER"
id      = "PASTE_RATE_LIMITER_ID_HERE"

[[kv_namespaces]]
binding = "JOB_STATE"
id      = "PASTE_JOB_STATE_ID_HERE"
```

### 2. Add your Replicate API key as a secret

Get a free API key at <https://replicate.com/account/api-tokens>.

```bash
wrangler secret put REPLICATE_API_KEY
# Paste your token and press Enter — it is stored encrypted, never in files.
```

### 3. Update the route in `wrangler.toml`

Edit the `[[routes]]` section to match your domain and Cloudflare zone:

```toml
[[routes]]
pattern   = "www.ebysplace.com/api/*"
zone_name = "ebysplace.com"
```

If you do not have a custom domain yet, remove the `[[routes]]` block and
use the default `*.workers.dev` URL that Wrangler assigns.

---

## Development

Run the worker locally with live reload:

```bash
cd worker
wrangler dev
```

The worker will be available at `http://localhost:8787`.

Update `tryon.html` temporarily to point to the local endpoint:

```js
const API_BASE = 'http://localhost:8787';
```

---

## Deployment

### Automatic (recommended) — GitHub Actions

The workflow `.github/workflows/deploy-worker.yml` runs on every push to `main`
that touches `worker/**`. It deploys the worker and syncs the `REPLICATE_API_KEY`
secret automatically.

**Add these three secrets once** under
`Settings → Secrets and variables → Actions → New repository secret`:

| Secret name | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) — create a token with **Edit Workers** permission |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → right sidebar on any zone page |
| `REPLICATE_API_KEY` | [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) |

Once the secrets are in place, push any change to `worker/` (or trigger the
workflow manually from the **Actions** tab) and the worker is live.

### Manual

```bash
cd worker
wrangler deploy
```

After deploying, `tryon.html` uses same-origin by default (`/api/*` on
`www.ebysplace.com`). If you need to target a `workers.dev` URL, set:

```js
localStorage.setItem('TRYON_API_BASE', 'https://<your-worker>.workers.dev')
```

then refresh the page.

---

## Pipeline details

### Stage 1 — `jonathandinu/face-parsing`

Segments the uploaded portrait using a BiSeNet model trained on CelebAMask-HQ.
Returns a coloured segmentation image where the hair region is distinctly
coloured (label 17 in the CelebAMask-HQ taxonomy).  This segmentation image
is used directly as the inpainting mask for stage 2.

Job state (original image data URL + inpainting prompt) is stored in the
`JOB_STATE` KV namespace under key `job:{stage1Id}` with a 1-hour TTL.

### Stage 2 — `black-forest-labs/flux-fill-pro`

Receives:
- `image` — the original uploaded photo (data URL, from KV)
- `mask`  — the hair segmentation from stage 1 (Replicate URL)
- `prompt` — the selected braid style description

FLUX Fill Pro inpaints only the pixels covered by the mask.  Because the
face lies outside the mask it is structurally unchanged — no negative prompts
or guidance tricks are needed.

### Stage transition (client-side)

When the worker detects that stage 1 has completed it immediately submits
stage 2 and returns:

```json
{ "status": "processing", "stage": 2, "jobId": "<new-stage2-id>" }
```

`tryon.html` detects `data.jobId !== currentJobId`, swaps to the new ID,
and continues polling.

---

## Security notes

* The `REPLICATE_API_KEY` secret is **never** exposed to the browser.
* Uploaded images are validated for MIME type and size server-side.
* IP-based rate limiting (5 requests / 60 s) is enforced via Cloudflare KV.
* CORS is restricted to `ebysplace.com` and `*.github.io` origins.
* Job state in KV uses a 1-hour TTL — original image data is never persisted
  beyond that window.
