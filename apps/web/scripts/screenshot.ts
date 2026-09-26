// Live check against `pnpm dev`: screenshots of real names on desktop and
// phone, and the p95 frame time while panning and zooming a 301-node map.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadDotEnv, loadEnv } from '@ensmap/core/config';
import { chromium, type Browser, type Page } from 'playwright-core';

import { syntheticGraph } from './syntheticGraph.ts';

const OUT_DIR = fileURLToPath(new URL('../.screenshots/', import.meta.url));
const READY = '[data-map-ready="true"]';
const ALERT = '[role="alert"]';
const PANEL = 'aside[aria-label="Name details"]';
const READY_TIMEOUT_MS = 120_000;
const TIMEOUT_MESSAGE = 'The lookup took too long. Try again.';
const NAMES = ['seller-a.eth', 'gloomy.eth'];
const PANEL_NAME = 'seller-a.eth';
const VIEWPORTS = [
  { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
];
const TIMING_MS = 3_000;
const P95_LIMIT_MS = 20;

type Viewport = (typeof VIEWPORTS)[number];

loadDotEnv();
const { values } = parseArgs({
  options: {
    base: {
      type: 'string',
      default: `http://localhost:${loadEnv().ENSMAP_WEB_PORT}`,
    },
  },
});
const base = values.base;

function pageUrl(name: string): string {
  return `${base}/?name=${encodeURIComponent(name)}`;
}

async function openPage(browser: Browser, viewport: Viewport): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    console.error(`page error: ${error.message}`);
    process.exitCode = 1;
  });
  return page;
}

// The API keeps building a map after the page gives up at 90 s and caches
// it, so a timeout earns a reload; any other error line fails the run.
async function waitForMap(page: Page, name: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const found = await page.waitForSelector(`${READY}, ${ALERT}`, {
      timeout: Math.max(1, deadline - Date.now()),
    });
    if ((await found.getAttribute('role')) !== 'alert') return;
    const message = (await found.textContent()) ?? '';
    if (message !== TIMEOUT_MESSAGE || Date.now() >= deadline) {
      throw new Error(`${name}: ${message}`);
    }
    console.error(`${name}: ${message} Reloading.`);
    await page.reload();
  }
}

async function assertNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow > 0) {
    throw new Error(`${label}: page scrolls sideways by ${overflow} px`);
  }
}

async function shoot(page: Page, file: string): Promise<string> {
  const path = join(OUT_DIR, file);
  await page.screenshot({ path, animations: 'disabled' });
  return path;
}

async function captureName(
  browser: Browser,
  name: string,
  viewport: Viewport,
): Promise<string[]> {
  const page = await openPage(browser, viewport);
  try {
    await page.goto(pageUrl(name));
    await waitForMap(page, name);
    const label = `${name} at ${viewport.width} px`;
    if (viewport.mobile) await assertNoHorizontalScroll(page, label);
    const shots = [await shoot(page, `${name}-${viewport.width}.png`)];

    if (name === PANEL_NAME) {
      const canvas = await page.locator('canvas').boundingBox();
      if (canvas === null) throw new Error(`${label}: no canvas`);
      await page.mouse.click(
        canvas.x + canvas.width / 2,
        canvas.y + canvas.height / 2,
      );
      await page.waitForSelector(PANEL, { timeout: 5_000 });
      if (viewport.mobile) await assertNoHorizontalScroll(page, label);
      shots.push(await shoot(page, `${name}-${viewport.width}-panel.png`));
    }
    return shots;
  } finally {
    await page.context().close();
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

// rAF deltas in the page. Sent as source text, since tsx would wrap a
// function argument in a __name helper that the page does not have.
function recordFrames(ms: number): string {
  return `new Promise((resolve) => {
    const deltas = [];
    let start = null;
    let last = 0;
    requestAnimationFrame(function loop(now) {
      if (start === null) start = now;
      else deltas.push(now - last);
      last = now;
      if (now - start < ${ms}) requestAnimationFrame(loop);
      else resolve(deltas);
    });
  })`;
}

// Alternates drags and wheel zooms around the middle of the map
async function interact(page: Page, until: number): Promise<void> {
  const canvas = await page.locator('canvas').boundingBox();
  if (canvas === null) throw new Error('frame timing: no canvas');
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  let turn = 0;
  while (Date.now() < until) {
    const dir = turn % 2 === 0 ? 1 : -1;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 220 * dir, cy + 120 * dir, { steps: 24 });
    await page.mouse.up();
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -60 * dir);
    }
    turn++;
  }
}

async function frameTiming(browser: Browser): Promise<number> {
  const page = await openPage(browser, VIEWPORTS[0] as Viewport);
  try {
    const body = JSON.stringify(syntheticGraph(20, 14));
    await page.route('**/api/map/name/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body }),
    );
    await page.goto(pageUrl('synthetic.eth'));
    await waitForMap(page, 'synthetic.eth');

    const [deltas] = await Promise.all([
      page.evaluate<number[]>(recordFrames(TIMING_MS)),
      interact(page, Date.now() + TIMING_MS),
    ]);
    const p95 = percentile(deltas, 0.95);
    console.log(
      `p95 frame ${p95.toFixed(1)} ms over ${deltas.length} frames (limit ${P95_LIMIT_MS} ms)`,
    );
    return p95;
  } finally {
    await page.context().close();
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const name of NAMES) {
      for (const viewport of VIEWPORTS) {
        for (const path of await captureName(browser, name, viewport)) {
          console.log(path);
        }
      }
    }
    const p95 = await frameTiming(browser);
    if (!(p95 <= P95_LIMIT_MS)) {
      console.error(`p95 frame ${p95.toFixed(1)} ms is over the limit`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
