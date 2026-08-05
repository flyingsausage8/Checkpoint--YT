/**
 * Forget everything cached for a video so the next visit does the real work.
 *
 * Transcripts and AI sections are cached per video id. When you are testing a
 * change to either, a stale cache will hide it: the run will look like it
 * succeeded without ever exercising the code you edited.
 *
 *   node tools/clear-cache.js            # every video
 *   node tools/clear-cache.js VIDEO_ID   # just one
 */
const { openExtensionPage, evaluate, sleep, requireChrome } = require('./cdp.js');

const videoId = process.argv[2] || null;
const PREFIXES = ['transcript:', 'sections:', 'questions:'];

(async () => {
  await requireChrome();
  const session = await openExtensionPage();
  await session.send('Runtime.enable');
  await sleep(1500);

  const result = await evaluate(
    session,
    `(async () => {
       const prefixes = ${JSON.stringify(PREFIXES)};
       const only = ${JSON.stringify(videoId)};
       const all = await chrome.storage.local.get(null);
       const keys = Object.keys(all).filter(
         (k) => prefixes.some((p) => k.startsWith(p)) && (!only || k.endsWith(only))
       );
       await chrome.storage.local.remove(keys);
       return JSON.stringify(keys);
     })()`
  );

  session.close();

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  const removed = JSON.parse(result.value);
  console.log(removed.length ? `cleared:\n  ${removed.join('\n  ')}` : 'nothing cached');
})();
