# Eby's Place — AI Try-On Worker

This directory contains a **Cloudflare Worker** that acts as the secure API
backend for the AI Try-On feature on `tryon.html`.

Because `ebysplace.com` is hosted on GitHub Pages (static files only), the
worker runs as a separate edge service and handles everything that requires a
secret key: calling the Replicate AI API, rate limiting requests, and
validating uploaded images.

---

## Architecture

```
Browser (tryon.html)
  │  POST /api/tryon         (multipart: photo + style + prompt)
  │  GET  /api/tryon/:jobId  (poll for result)
  ▼
Cloudflare Worker  (this directory)
  │  submit prediction / poll status
  ▼
Replicate API  →  timothybrooks/instruct-pix2pix
```

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

### 1. Create a KV namespace for rate limiting

```bash
wrangler kv namespace create RATE_LIMITER
```

Copy the `id` from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMITER"
id      = "PASTE_YOUR_ID_HERE"
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
pattern   = "api.ebysplace.com/api/*"
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

```bash
cd worker
wrangler deploy
```

After deploying, update the `API_BASE` constant at the top of `tryon.html`
to point to your worker URL, then push to `main` to redeploy GitHub Pages.

---

## Changing the AI model

The worker defaults to **`timothybrooks/instruct-pix2pix`** on Replicate,
an instruction-tuned diffusion model that accepts an input photo and a text
instruction ("change the hairstyle to knotless braids") and modifies only
the described region while preserving the rest of the image.

To switch models, update the two constants near the top of `index.js`:

```js
const REPLICATE_MODEL_OWNER = 'timothybrooks';
const REPLICATE_MODEL_NAME  = 'instruct-pix2pix';
```

Ensure the replacement model accepts the same `input` schema (or update
`replicateSubmit()` accordingly).

---

## Security notes

* The `REPLICATE_API_KEY` secret is **never** exposed to the browser.
* Uploaded images are validated for MIME type and size server-side.
* IP-based rate limiting (5 requests / 60 s) is enforced via Cloudflare KV.
* CORS is restricted to `ebysplace.com` and `*.github.io` origins.
