window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.ai = (() => {
  const AI_PROXY_ENABLED_IN_THIS_BUILD = true;
  // Replace this with your deployed Azure Function URL before sharing the extension.
  const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';
  const TIMEOUT_MS = 20000;

  function storageGet(area, keys) {
    return new Promise((resolve) => chrome.storage[area].get(keys, resolve));
  }

  function endpointFromBase(baseUrl) {
    const url = String(baseUrl || DEFAULT_PROXY_URL).trim().replace(/\/+$/, '');
    return url.endsWith('/generate') ? url : `${url}/api/generate`;
  }

  async function generateForVideo({ videoId, title, chunks }) {
    if (!AI_PROXY_ENABLED_IN_THIS_BUILD) return null;
    if (!videoId || !Array.isArray(chunks) || !chunks.length) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const settings = await storageGet('sync', { proxyUrl: DEFAULT_PROXY_URL });
      const response = await fetch(endpointFromBase(settings.proxyUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, title, chunks }),
        signal: controller.signal,
      });

      if (!response.ok) return null;
      const body = await response.json();
      return window.FocusFlow.validate.questions(body.questions, chunks.length);
    } catch (error) {
      console.warn('[FocusFlow] AI questions unavailable:', error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { generateForVideo, DEFAULT_PROXY_URL };
})();
