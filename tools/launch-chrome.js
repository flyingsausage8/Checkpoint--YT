/**
 * Start a Chrome instance this toolchain can drive.
 *
 * A separate profile directory is used so the browser under test never touches
 * your real one, and so runs start from a known, signed-out state.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CDP_HTTP } = require('./cdp.js');

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];

const port = new URL(CDP_HTTP).port || '9222';
const profile =
  process.env.FOCUSFLOW_PROFILE || path.join(os.tmpdir(), 'focusflow-test-profile');

const binary =
  process.env.CHROME_PATH || CANDIDATES.find((p) => fs.existsSync(p));

if (!binary) {
  console.error(
    'Could not find Chrome. Set CHROME_PATH to the executable and try again.'
  );
  process.exit(1);
}

const child = spawn(
  binary,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  { detached: true, stdio: 'ignore' }
);
child.unref();

console.log(`Chrome starting on ${CDP_HTTP} (profile: ${profile})`);
console.log('Next:  node tools/reload-extension.js');
