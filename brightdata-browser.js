#!/usr/bin/env node
// Starts N Multilogin X profiles (each with its own fingerprint + Bright Data proxy),
// attaches Playwright, and watches every tab for MATCH_STRING. When found, that
// window is brought to the front.
//
// Requires the Multilogin X desktop app/agent to be running.
// Usage: node --env-file=.env brightdata-browser.js [url]   (url overrides START_URL in .env)

const crypto = require('crypto');
const { chromium } = require('playwright');
const { fetch } = require('undici');

const {
  MLX_TOKEN,                  // automation token (recommended), or use email/password below
  MLX_EMAIL,
  MLX_PASSWORD,
  MLX_FOLDER_ID,
  MLX_PROFILE_IDS,            // comma-separated profile IDs, one window each
  MLX_LAUNCHER = 'https://launcher.mlx.yt:45001',
  MATCH_STRING = 'Hello world',
  MATCH_IN = 'html',          // 'html' = raw page source, 'text' = visible text only
  POLL_MS = '1000',
  START_URL = 'https://browserleaks.com/ip',
} = process.env;

const profileIds = (MLX_PROFILE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!MLX_FOLDER_ID || !profileIds.length || !(MLX_TOKEN || (MLX_EMAIL && MLX_PASSWORD))) {
  console.error('Missing MLX_FOLDER_ID, MLX_PROFILE_IDS, or MLX_TOKEN / MLX_EMAIL+MLX_PASSWORD.');
  console.error('See .env.example');
  process.exit(1);
}
const startUrl = process.argv[2] || START_URL;

// ---------- Multilogin API ----------

async function getToken() {
  if (MLX_TOKEN) return MLX_TOKEN;
  const res = await fetch('https://api.multilogin.com/user/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      email: MLX_EMAIL,
      password: crypto.createHash('md5').update(MLX_PASSWORD).digest('hex'), // API expects MD5
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.data?.token) throw new Error(`Multilogin sign-in failed: ${JSON.stringify(json)}`);
  return json.data.token;
}

async function launcher(token, path) {
  const res = await fetch(`${MLX_LAUNCHER}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Launcher ${path} failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const startProfile = (token, id) =>
  launcher(token, `/api/v2/profile/f/${MLX_FOLDER_ID}/p/${id}/start?automation_type=playwright&headless_mode=false`);

const stopProfile = (token, id) => launcher(token, `/api/v1/profile/stop/p/${id}`).catch(() => {});

// ---------- Window handling ----------

// page.bringToFront() only switches tabs; bouncing the window state via CDP
// forces most OSes to raise the window too.
async function raiseWindow(context, page) {
  await page.bringToFront();
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.detach();
  } catch {
    // tab switch alone will have to do
  }
}

// Every POLL_MS, read each tab's current DOM (no reloading) and look for MATCH_STRING.
function watch({ n, context, browser }) {
  const found = new WeakSet(); // alert once per appearance
  let busy = false;

  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const page of context.pages()) {
        const hit = await page
          .evaluate(
            ([needle, mode]) =>
              (mode === 'text'
                ? document.body?.innerText ?? ''
                : document.documentElement.outerHTML
              ).includes(needle),
            [MATCH_STRING, MATCH_IN]
          )
          .catch(() => false);

        if (hit && !found.has(page)) {
          found.add(page);
          console.log(`\x07[${n}] FOUND "${MATCH_STRING}" on ${page.url()}`);
          await raiseWindow(context, page);
        } else if (!hit && found.has(page)) {
          found.delete(page);
        }
      }
    } finally {
      busy = false;
    }
  }, Number(POLL_MS));

  browser.on('disconnected', () => clearInterval(timer));
}

// ---------- Main ----------

async function startInstance(token, id, n) {
  const { data } = await startProfile(token, id);
  if (!data?.port) throw new Error('Launcher did not return a CDP port');

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${data.port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());

  // Check the public IP from inside the browser, so it goes through the profile's proxy.
  const ip = await page
    .evaluate(() => fetch('https://api.ipify.org?format=json').then((r) => r.json()).then((j) => j.ip))
    .catch(() => 'unknown');
  console.log(`[${n}] profile ${id}  IP ${ip}`);

  await page.goto(startUrl).catch((e) => console.warn(`[${n}] load failed: ${e.message}`));
  return { n, id, ip, browser, context };
}

(async () => {
  const token = await getToken();

  const results = await Promise.allSettled(profileIds.map((id, i) => startInstance(token, id, i + 1)));
  const running = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') running.push(r.value);
    else console.error(`[${i + 1}] profile ${profileIds[i]} failed: ${r.reason.message}`);
  });
  if (!running.length) process.exit(1);

  const ips = running.map((r) => r.ip).filter((ip) => ip !== 'unknown');
  if (new Set(ips).size < ips.length) {
    console.warn('Warning: some profiles share an IP. Give each profile a different Bright Data IP.');
  }

  running.forEach(watch);
  console.log(`${running.length} profile(s) open, watching for "${MATCH_STRING}" every ${POLL_MS}ms.`);
  console.log('Close all windows or press Ctrl+C to exit.');

  const shutdown = async () => {
    await Promise.all(running.map((r) => stopProfile(token, r.id)));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);

  let open = running.length;
  running.forEach((r) =>
    r.browser.on('disconnected', () => --open === 0 && shutdown())
  );
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
