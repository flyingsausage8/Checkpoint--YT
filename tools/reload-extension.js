/**
 * Install (or re-install) this extension into the running test browser.
 *
 * Chrome 150 removed the --load-extension command line switch, and
 * --disable-features=DisableLoadExtensionCommandLineSwitch does not bring it
 * back. Extensions.loadUnpacked over the DevTools Protocol is the way that
 * still works, and it is also how you pick up code changes: reloading is
 * required after every edit, because the browser caches the old files.
 */
const {
  browserSession,
  EXTENSION_DIR,
  requireChrome,
  fail,
} = require('./cdp.js');

(async () => {
  await requireChrome();
  const session = await browserSession();
  try {
    const result = await session.send('Extensions.loadUnpacked', {
      path: EXTENSION_DIR,
    });
    console.log(`loaded ${EXTENSION_DIR}`);
    console.log(`extension id: ${result.id}`);
  } catch (error) {
    fail(`Extensions.loadUnpacked failed: ${error.message.slice(0, 400)}`);
  } finally {
    session.close();
  }
})();
