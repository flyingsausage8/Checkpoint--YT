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
const TIMEOUT_MS = 30000;

function endpointFromBase(baseUrl) {
  const url = String(baseUrl || DEFAULT_PROXY_URL).trim().replace(/\/+$/, '');
  return url.endsWith('/generate') ? url : `${url}/api/generate`;
}

async function postToBackend(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const { proxyUrl } = await chrome.storage.sync.get({ proxyUrl: DEFAULT_PROXY_URL });
    const endpoint = endpointFromBase(proxyUrl);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `http_${response.status}`, endpoint };
    }
    const body = await response.json();
    return { ok: true, body, endpoint };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function requestQuestions({ videoId, title, chunks }) {
  const result = await postToBackend({ videoId, title, chunks });
  if (!result.ok) return { ok: false, error: result.error, endpoint: result.endpoint };
  return {
    ok: true,
    questions: result.body.questions,
    diagnostics: result.body.diagnostics,
    endpoint: result.endpoint,
  };
}

// Issue #1: segment mode asks the backend where the natural topic breaks are.
async function requestSegments(payload) {
  const result = await postToBackend({ ...payload, mode: 'segment' });
  if (!result.ok) return { ok: false, error: result.error, endpoint: result.endpoint };
  return {
    ok: true,
    sections: result.body.sections,
    diagnostics: result.body.diagnostics,
    endpoint: result.endpoint,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'focusflow:generate-questions') {
    requestQuestions(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'focusflow:segment-video') {
    requestSegments(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});
