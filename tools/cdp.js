/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Node 18+ ships a global WebSocket and fetch, so this needs no dependencies —
 * which matters, because these tools must keep working on machines where npm
 * install is unavailable.
 */
const path = require('path');

const CDP_HTTP = process.env.FOCUSFLOW_CDP || 'http://127.0.0.1:9222';

// The extension id is pinned by the signing key in manifest.json, so it is
// stable across reloads and safe to hard-code. Override it if you repack.
const EXTENSION_ID =
  process.env.FOCUSFLOW_EXT_ID || 'obdbogcpgepohhgmmhggnflagmebboee';

// tools/ lives inside the extension directory.
const EXTENSION_DIR = path.resolve(__dirname, '..');

async function listTargets() {
  return (await fetch(`${CDP_HTTP}/json/list`)).json();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((fn) => fn(msg));
      }
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Session(ws);
  }

  send(method, params = {}, timeoutMs = 90000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch (_) {
      /* already gone */
    }
  }
}

/** Attach to the browser itself rather than a page. */
async function browserSession() {
  const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  return Session.attach(version.webSocketDebuggerUrl);
}

/** Open a new tab and attach to it. */
async function openTab(url) {
  const res = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const tab = await res.json();
  return Session.attach(tab.webSocketDebuggerUrl);
}

/** Open an extension page, which is the only place chrome.* APIs are reachable. */
function openExtensionPage(page = 'src/popup/popup.html') {
  return openTab(`chrome-extension://${EXTENSION_ID}/${page}`);
}

async function evaluate(session, expression, contextId) {
  const params = { expression, awaitPromise: true, returnByValue: true };
  if (contextId) params.contextId = contextId;
  const r = await session.send('Runtime.evaluate', params);
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.exception?.description || 'exception' };
  }
  return { value: r.result.value };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Friendlier error than a raw ECONNREFUSED when Chrome is not listening. */
async function requireChrome() {
  try {
    await fetch(`${CDP_HTTP}/json/version`);
  } catch (_) {
    fail(
      `No Chrome with remote debugging on ${CDP_HTTP}.\n` +
        `Start one first:  node tools/launch-chrome.js`
    );
  }
}

module.exports = {
  CDP_HTTP,
  EXTENSION_ID,
  EXTENSION_DIR,
  Session,
  browserSession,
  openTab,
  openExtensionPage,
  listTargets,
  evaluate,
  sleep,
  fail,
  requireChrome,
};
