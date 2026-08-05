/**
 * Report what was actually captured for a video, and whether it covers it.
 *
 * A transcript can look fine by cue count and still be missing the second half
 * of the video, so this reports the range it spans and any suspicious gaps
 * rather than just a total.
 *
 *   node tools/inspect-transcript.js VIDEO_ID
 */
const { openExtensionPage, evaluate, sleep, requireChrome } = require('./cdp.js');

const videoId = process.argv[2];
if (!videoId) {
  console.error('usage: node tools/inspect-transcript.js VIDEO_ID');
  process.exit(1);
}

(async () => {
  await requireChrome();
  const session = await openExtensionPage();
  await session.send('Runtime.enable');
  await sleep(1500);

  const result = await evaluate(
    session,
    `(async () => {
       const key = 'transcript:' + ${JSON.stringify(videoId)};
       const stored = await chrome.storage.local.get(key);
       const transcript = stored[key];
       if (!transcript) return JSON.stringify({ cached: false });

       const cues = transcript.cues || [];
       const gaps = [];
       for (let i = 1; i < cues.length; i++) {
         const gap = cues[i].start - cues[i - 1].start;
         if (gap > 20) {
           gaps.push({ afterSeconds: Math.round(cues[i - 1].start), gapSeconds: Math.round(gap) });
         }
       }
       return JSON.stringify({
         cached: true,
         source: transcript.source,
         truncated: transcript.truncated || false,
         cueCount: cues.length,
         firstStart: cues[0]?.start ?? null,
         lastStart: cues[cues.length - 1]?.start ?? null,
         suspiciousGaps: gaps.slice(0, 10),
         suspiciousGapCount: gaps.length,
       }, null, 1);
     })()`
  );

  session.close();
  console.log(result.value || result.error);
})();
