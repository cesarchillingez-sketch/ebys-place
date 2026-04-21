# Eby's Place — AI Try-On Worker

This directory contains a **Cloudflare Worker** that acts as the secure API
backend for the AI Try-On feature on `tryon.html`.

Because `ebysplace.com` is hosted on GitHub Pages (static files only), the
worker runs as a separate edge service and handles everything that requires a
secret key: calling the Replicate AI API and validating uploaded images.

---

## Architecture — 2-stage pipeline (exact face preservation)

```
Browser (tryon.html)
  │  POST /api/tryon           (multipart: photo + style + prompt)
  │  GET  /api/tryon/:jobId    (poll stage 1 until mask is ready)
  │  POST /api/tryon/inpaint   (JSON: image + mask + prompt → start stage 2)
  │  GET  /api/tryon/:jobId    (poll stage 2 until final image is ready)
  ▼
Cloudflare Worker  (this directory)
  │
  ├─ Stage 1 ─ jonathandinu/face-parsing
  │            Segments the photo; returns a hair-region mask image URL.
  │
  └─ Stage 2 ─ black-forest-labs/flux-fill-pro
               Inpaints only the masked hair region.
               Face pixels lie outside the mask → zero AI drift.
```

Pipeline state (original image, mask URL, prompt) is tracked **client-side**
in `tryon.html`, so no Cloudflare KV namespaces are required.

**Why exact face preservation?**
The 2-stage pipeline uses a structural mask, so the model is physically
prevented from touching any pixel outside the hair region.  The face, eyes,
skin tone, and expression are preserved exactly.

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

### 1. Add your Replicate API key as a secret

Get a free API key at <https://replicate.com/account/api-tokens>.

```bash
wrangler secret put REPLICATE_API_KEY
# Paste your token and press Enter — it is stored encrypted, never in files.
```

### 2. Update the route in `wrangler.toml`

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
localStorage.setItem('TRYON_API_BASE', 'http://localhost:8787')
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

### Stage 2 — `black-forest-labs/flux-fill-pro`

Receives:
- `image` — the original uploaded photo (data URL, from the browser)
- `mask`  — the hair segmentation URL from stage 1
- `prompt` — the selected braid style description

FLUX Fill Pro inpaints only the pixels covered by the mask.  Because the
face lies outside the mask it is structurally unchanged — no negative prompts
or guidance tricks are needed.

### Stage transition (client-side)

`tryon.html` drives the pipeline:
1. Submits stage 1 via `POST /api/tryon`, receives a `jobId`.
2. Polls `GET /api/tryon/:jobId` until `status === "succeeded"` — the `url`
   in the response is the hair mask.
3. Submits stage 2 via `POST /api/tryon/inpaint` with the original image,
   mask URL, and prompt.
4. Polls the new stage-2 `jobId` until `status === "succeeded"` — the `url`
   is the final result image shown to the user.

---

## Security notes

* The `REPLICATE_API_KEY` secret is **never** exposed to the browser.
* Uploaded images are validated for MIME type and size server-side.
* CORS is restricted to `ebysplace.com` and `*.github.io` origins.
