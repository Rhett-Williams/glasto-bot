#!/usr/bin/env node
// Opens N visible Chrome windows, each routed through its own Bright Data ISP proxy IP.
// Usage: node --env-file=.env brightdata-browser.js [startUrl]

const path = require('path');
const { chromium } = require('playwright');
const { fetch, ProxyAgent } = require('undici');

const {
  BRD_CUSTOMER_ID,
  BRD_ZONE,
  BRD_PASSWORD,
  BRD_IPS,                     // optional: comma-separated IPs from your zone, one per window
  BROWSER_COUNT = '5',         // used when BRD_IPS isn't set
  BRD_HOST = 'brd.superproxy.io',
  BRD_PORT = '44445',
  BROWSER_LOCALE = 'en-GB',
  MATCH_STRING = 'Hello world',  // text to watch for on every page
  MATCH_IN = 'html',             // 'html' = raw page source, 'text' = visible text only
  POLL_MS = '1000',
} = process.env;

if (!BRD_CUSTOMER_ID || !BRD_ZONE || !BRD_PASSWORD) {
  console.error('Missing BRD_CUSTOMER_ID, BRD_ZONE or BRD_PASSWORD. See .env.example');
  process.exit(1);
}

const server = `http://${BRD_HOST}:${BRD_PORT}`;
const startUrl = process.argv[2] || 'https://browserleaks.com/ip';
const baseUser = `brd-customer-${BRD_CUSTOMER_ID}-zone-${BRD_ZONE}`;

// Each window gets a username that locks it to one IP:
//  - "-ip-<ip>"     pins an exact IP (most reliable)
//  - "-session-<id>" asks Bright Data to keep the same IP for that session id
const pinnedIps = BRD_IPS ? BRD_IPS.split(',').map((s) => s.trim()).filter(Boolean) : [];
const instances = pinnedIps.length
  ? pinnedIps.map((ip, i) => ({ id: i + 1, username: `${baseUser}-ip-${ip}` }))
  : Array.from({ length: Number(BROWSER_COUNT) }, (_, i) => ({
      id: i + 1,
      username: `${baseUser}-session-win${i + 1}`,
    }));

async function getProxyInfo(username) {
  const agent = new ProxyAgent(
    `http://${username}:${encodeURIComponent(BRD_PASSWORD)}@${BRD_HOST}:${BRD_PORT}`
  );
  const res = await fetch('http://brdtest.com/myip.json', { dispatcher: agent });
  if (!res.ok) {
    const code = res.headers.get('x-brd-err-code') || 'unknown';
    throw new Error(`HTTP ${res.status}, Bright Data error ${code}`);
  }
  return res.json();
}

async function launch({ id, username }, info, useInstalledChrome) {
  // Tile windows so they don't stack exactly on top of each other
  const x = ((id - 1) % 3) * 640;
  const y = Math.floor((id - 1) / 3) * 480;
  return chromium.launchPersistentContext(path.join(__dirname, `.brd-profile-${id}`), {
    ...(useInstalledChrome && { channel: 'chrome' }),
    headless: false,
    viewport: null,
    proxy: { server, username, password: BRD_PASSWORD },
    timezoneId: info.geo?.tz,
    geolocation: info.geo && { latitude: info.geo.latitude, longitude: info.geo.longitude },
    locale: BROWSER_LOCALE,
    args: [
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--force-webrtc-ip-handling-policy',
      `--window-position=${x},${y}`,
      '--window-size=640,480',
    ],
  });
}

async function startInstance(inst) {
  const info = await getProxyInfo(inst.username);
  console.log(`[${inst.id}] ${info.ip}  ${info.geo?.city}, ${info.country}  ${info.asn?.org_name}`);

  let context;
  try {
    context = await launch(inst, info, true);
  } catch {
    context = await launch(inst, info, false); // no installed Chrome: use Playwright Chromium
  }
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(startUrl).catch((e) => console.warn(`[${inst.id}] load failed: ${e.message}`));
  return { ...inst, ip: info.ip, context };
}

// Raise a page's OS window to the front. page.bringToFront() only switches tabs,
// so we also bounce the window state via CDP, which forces most OSes to raise it.
async function raiseWindow(context, page) {
  await page.bringToFront();
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.detach();
  } catch {
    // CDP unavailable: tab switch alone will have to do
  }
}

// Every POLL_MS, read each open tab's current DOM (no reloading) and look for MATCH_STRING.
function watch(instance) {
  const { id, context } = instance;
  const found = new WeakSet(); // pages currently showing the string, so we alert once per appearance
  let busy = false;

  const timer = setInterval(async () => {
    if (busy) return; // skip a tick if the previous check is still running
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
          .catch(() => false); // page mid-navigation or closed

        if (hit && !found.has(page)) {
          found.add(page);
          console.log(`\x07[${id}] FOUND "${MATCH_STRING}" on ${page.url()}`); // \x07 = terminal beep
          await raiseWindow(context, page);
        } else if (!hit && found.has(page)) {
          found.delete(page); // string went away; alert again if it comes back
        }
      }
    } finally {
      busy = false;
    }
  }, Number(POLL_MS));

  context.on('close', () => clearInterval(timer));
}

(async () => {
  const results = await Promise.allSettled(instances.map(startInstance));
  const running = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') running.push(r.value);
    else console.error(`[${instances[i].id}] failed: ${r.reason.message}`);
  });
  if (!running.length) process.exit(1);

  const ips = running.map((r) => r.ip);
  if (new Set(ips).size < ips.length) {
    console.warn('Warning: some windows share an IP. Your zone may have fewer IPs than windows,');
    console.warn('or set BRD_IPS to pin each window to a specific IP.');
  }

  running.forEach(watch);
  console.log(`${running.length} browser(s) open, watching for "${MATCH_STRING}" every ${POLL_MS}ms.`);
  console.log('Close them all to exit.');
  let open = running.length;
  running.forEach((r) => r.context.on('close', () => --open === 0 && process.exit(0)));
})();
