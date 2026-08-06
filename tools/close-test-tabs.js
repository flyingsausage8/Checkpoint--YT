// Closes every YouTube and extension tab left open by a test run.
//
// Test scripts should close their own tabs, but a script that crashes or is
// interrupted cannot. Run this afterwards, or any time the browser has filled
// up with tabs still playing video.
//
//   node tools/close-test-tabs.js

const { closeAllVideoTabs, requireChrome } = require('./cdp');

(async () => {
  await requireChrome();
  const closed = await closeAllVideoTabs();
  console.log(`closed ${closed} tab(s)`);
})();
