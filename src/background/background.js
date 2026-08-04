/**
 * Background service worker.
 *
 * All calls to the Azure Function happen here, never in the content script.
 * A content script inherits the page's origin, so its requests are sent with
 * `Origin: https://www.youtube.com` and are subject to CORS. Requests made from
 * the service worker carry the extension's own `chrome-extension://<id>` origin
 * and bypass CORS because the host is declared in `host_permissions` — which is
 * also what lets the backend's origin allowlist mean something.
 */
const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';
const TIMEOUT_MS = 20000;

function endpointFromBase(baseUrl) {
  const url = String(baseUrl || DEFAULT_PROXY_URL).trim().replace(/\/+$/, '');
  return url.endsWith('/generate') ? url : `${url}/api/generate`;
}

async function requestQuestions({ videoId, title, chunks }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const { proxyUrl } = await chrome.storage.sync.get({ proxyUrl: DEFAULT_PROXY_URL });
    const response = await fetch(endpointFromBase(proxyUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id,
      },
      body: JSON.stringify({ videoId, title, chunks }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `http_${response.status}` };
    }
    const body = await response.json();
    return { ok: true, questions: body.questions };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'focusflow:generate-questions') return false;

  requestQuestions(message.payload || {})
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
