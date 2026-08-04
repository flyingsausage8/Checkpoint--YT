# FocusFlow Proxy Worker

This Cloudflare Worker is the secure backend for Phase 3 AI questions. The Chrome extension sends transcript chunks to this Worker. The Worker validates the request, rate-limits it, calls OpenAI with the developer's API key, validates the model output, and returns questions.


> **Important:** the current Phase 2 testing build removes `https://*.workers.dev/*` from `manifest.json` host permissions so the extension has a cleaner install prompt and cannot call the proxy. When you are ready to enable this Worker, add `"https://*.workers.dev/*"` back to `host_permissions`, reload the extension, and then use the popup's AI settings.

## Deploy step by step

1. Create a Cloudflare account at https://dash.cloudflare.com.
2. Install Node.js from https://nodejs.org if you do not already have it.
3. Open a terminal in the `focusflow\proxy` folder.
4. Log in to Cloudflare:

   ```powershell
   npx wrangler login
   ```

5. Create the KV namespace used for rate limiting:

   ```powershell
   npx wrangler kv namespace create RATE_LIMIT
   ```

6. Copy the `id` printed by Wrangler. Open `wrangler.toml`, uncomment the `[[kv_namespaces]]` block, and paste that id.
7. Set your OpenAI API key as a Worker secret:

   ```powershell
   npx wrangler secret put OPENAI_API_KEY
   ```

   Paste the key when Wrangler asks. Never put the real key in `.dev.vars`, source code, GitHub, or the extension.

8. Deploy once:

   ```powershell
   npx wrangler deploy
   ```

9. Wrangler prints a URL like `https://focusflow-proxy.YOUR-SUBDOMAIN.workers.dev`. Save it.
10. Find your extension id:
    - Open Chrome.
    - Go to `chrome://extensions`.
    - Turn on **Developer mode**.
    - Look under FocusFlow for the **ID** value.
11. In `wrangler.toml`, set `ALLOWED_ORIGINS` to your extension origin:

    ```toml
    ALLOWED_ORIGINS = "chrome-extension://YOUR_EXTENSION_ID"
    ```

12. Redeploy:

    ```powershell
    npx wrangler deploy
    ```

13. Open the FocusFlow popup in Chrome and paste your Worker URL into **Proxy Worker URL**.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and put a test key there only for local development. The real `.dev.vars` file is ignored by Git and must stay private.

Run:

```powershell
npx wrangler dev
```

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| 401 from OpenAI | OpenAI rejected the API key | Re-run `npx wrangler secret put OPENAI_API_KEY` with a valid key. |
| 403 `origin_rejected` | The extension origin is not in `ALLOWED_ORIGINS` | Check the extension id at `chrome://extensions`, update `wrangler.toml`, and redeploy. |
| 429 `rate_limited` | One IP used the proxy too much | Wait for the `Retry-After` time or adjust limits in `src\index.js`. |
| 500 `missing_openai_key` | The Worker secret is not set | Run `npx wrangler secret put OPENAI_API_KEY` and redeploy. |
| 500 `server_error` | Unexpected Worker or OpenAI failure | Check Cloudflare Worker logs. The Worker intentionally does not log transcript text. |

## Cost warning

Set a hard monthly spending limit in your OpenAI billing dashboard. Code-level rate limits help, but billing caps are the final protection against surprise costs.
