window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.ai = (() => {
  const AI_PROXY_ENABLED_IN_THIS_BUILD = true;
  const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';

  // The network call is delegated to the background service worker. Fetching
  // from here would carry YouTube's origin and be blocked by CORS.
  function askBackground(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'focusflow:generate-questions', payload },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'no_response' });
        }
      );
    });
  }

  async function generateForVideo({ videoId, title, chunks }) {
    if (!AI_PROXY_ENABLED_IN_THIS_BUILD) return null;
    if (!videoId || !Array.isArray(chunks) || !chunks.length) return null;

    const result = await askBackground({ videoId, title, chunks });
    if (!result?.ok) {
      console.warn('[FocusFlow] AI questions unavailable:', result?.error || 'unknown');
      return null;
    }
    return window.FocusFlow.validate.questions(result.questions, chunks.length);
  }

  return { generateForVideo, DEFAULT_PROXY_URL };
})();
