/**
 * Watch the whole pipeline run against a real YouTube video.
 *
 * Every line is stamped with how long after page load it appeared, which is
 * what makes this useful: several past bugs were not wrong output but output
 * that arrived thirty seconds late, and a plain console log hides that.
 *
 *   node tools/run-video.js VIDEO_ID [seconds]
 */
const { openTab, listTargets, Session, evaluate, sleep, requireChrome, EXTENSION_ID } =
  require('./cdp.js');

const videoId = process.argv[2];
const waitSeconds = Number(process.argv[3] || 120);

if (!videoId) {
  console.error('usage: node tools/run-video.js VIDEO_ID [seconds]');
  process.exit(1);
}

function renderArg(arg) {
  if (arg.value !== undefined) {
    return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value);
  }
  if (arg.preview) {
    const props = (arg.preview.properties || [])
      .map((p) => `${p.name}: ${p.value}`)
      .join(', ');
    return `{${props}}`;
  }
  return arg.description || '';
}

/**
 * The blue STEP badges are drawn with `%c`, so the CSS that styled them arrives
 * as its own console argument. Drop those arguments rather than trying to cut
 * the CSS back out of the joined string, which risks eating real values like
 * the endpoint URL.
 */
function isStyleArg(text) {
  return (
    /^(?:[a-z-]+\s*:\s*[^;]+;\s*)*[a-z-]+\s*:\s*[^;]+$/i.test(text) &&
    /\b(?:background|color|padding|border-radius|font)\s*:/i.test(text)
  );
}

(async () => {
  await requireChrome();

  const started = Date.now();
  const page = await openTab(`https://www.youtube.com/watch?v=${videoId}`);
  const lines = [];

  page.on((msg) => {
    if (msg.method !== 'Runtime.consoleAPICalled') return;
    const parts = (msg.params.args || []).map(renderArg).filter((a) => !isStyleArg(a));
    const text = parts.join(' ').replace(/%c/g, '').replace(/\s{2,}/g, ' ').trim();
    if (!/FocusFlow/i.test(text)) return;
    const at = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
    lines.push(`+${at}s [${msg.params.type}] ${text}`);
  });

  await page.send('Runtime.enable');
  await page.send('Page.enable');

  // The service worker is often dormant; attach only if it is awake.
  await sleep(4000);
  const swTarget = (await listTargets()).find(
    (t) => t.type === 'service_worker' && t.url.includes(EXTENSION_ID)
  );
  const swLines = [];
  let sw = null;
  if (swTarget) {
    sw = await Session.attach(swTarget.webSocketDebuggerUrl);
    sw.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        swLines.push((msg.params.args || []).map(renderArg).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        swLines.push(`EXCEPTION ${msg.params.exceptionDetails.exception?.description || ''}`);
      }
    });
    await sw.send('Runtime.enable');
  }

  // Play muted so checkpoint logic runs the way it would for a real viewer.
  await evaluate(
    page,
    `(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play?.(); } return 1; })()`
  );

  console.log(`watching ${videoId} for ${waitSeconds}s...\n`);
  await sleep(waitSeconds * 1000);

  console.log('=== page console ===');
  console.log(lines.length ? lines.join('\n') : '  (nothing — is the extension loaded?)');

  if (swLines.length) {
    console.log('\n=== service worker ===');
    console.log(swLines.join('\n'));
  }

  page.close();
  if (sw) sw.close();
})();
