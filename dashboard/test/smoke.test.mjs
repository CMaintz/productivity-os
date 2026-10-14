// Browser smoke test of demo mode against the built dist/ (npm run build && npm run smoke).
// Needs a real browser, so it isn't part of the gate: $PW_EXECUTABLE, else the installed Edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { codeWidgetIds } from '../../tools/widgets/code-registry.mjs';

const DIST = new URL('../dist/', import.meta.url).pathname;
// Per-widget screenshots land here (CI uploads them as an artifact); SHOTS overrides.
const SHOTS = process.env.SHOTS ?? new URL('../test-results/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

/** The production _headers rules (Cloudflare syntax, incl. `! Name` removals), so the CSPs are enforced here too. */
async function headersFor(urlPath) {
  const blocks = (await readFile(join(DIST, '_headers'), 'utf8')).split(/\n(?=\S)/).filter(b => b.startsWith('/'));
  const out = {};
  for (const [pattern, ...lines] of blocks.map(b => b.trim().split('\n'))) {
    if (!new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(urlPath)) continue;
    for (const line of lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
      if (line.startsWith('! ')) delete out[line.slice(2).toLowerCase()];
      else { const i = line.indexOf(':'); out[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
    }
  }
  return out;
}

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(DIST, path.endsWith('/') ? `${path}index.html` : path);
    try { res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...(await headersFor(path)) }).end(await readFile(file)); }
    catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

const launch = () => chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : { channel: process.env.PW_CHANNEL ?? 'msedge' });

const check = (name, ok) => assert.ok(ok, name);

const VIEWPORTS = [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]];

/** Opens `url` on the built dashboard in a fresh browser and hands the page and its console errors to fn. */
async function withPage(viewport, url, fn) {
  const server = await serve();
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}${url}`, { waitUntil: 'networkidle' });
    await fn(page, errors);
  } finally {
    await browser.close();
    server.close();
  }
}

const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const [label, viewport] of VIEWPORTS) {
  test(`demo dashboard on ${label}`, () => withPage(viewport, '/?demo', async (page, errors) => {
    await page.waitForSelector('#cards');
    for (const id of ['today', 'attention', 'cards', 'sessions', 'writing', 'projects']) check(`${label}: #${id} renders`, await page.locator(`#${id}`).isVisible());
    check(`${label}: two pending cards with buttons`, (await page.locator('#cards ul.cards:not(.auto) > .card').count()) === 2);
    check(`${label}: declarative kanban widget groups notes by status`, (await page.locator('#writing .kanban > section').count()) === 3);
    check(`${label}: today shows the Top 3`, (await page.locator('#today .top3 li').count()) === 3);
    check(`${label}: waiting session listed first`, (await page.locator('#sessions tbody tr').first().textContent()).includes('waiting'));
    const first = page.locator('#cards .card').first();
    await first.locator('input.reason').fill('just testing');
    await first.getByRole('button', { name: 'Do it', exact: true }).click();
    check(`${label}: pressing a button shows the sent state`, (await first.locator('.sent').textContent()).includes('Demo mode'));
    check(`${label}: buttons disable after a press`, await first.getByRole('button', { name: 'No', exact: true }).isDisabled());
    check(`${label}: no horizontal page scroll`, await noScroll(page));
    assert.deepEqual(errors, [], `${label}: no console errors`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/dashboard-${label}.png`, fullPage: true });
  }));

  for (const id of codeWidgetIds()) {
    test(`code widget ${id} renders from its fixture, sandboxed, on ${label}`, () => withPage(viewport, `/?demo&widget=${id}`, async (page, errors) => {
      await page.waitForSelector(`#${id} iframe.code-frame`);
      const frame = page.frameLocator(`#${id} iframe`);
      await frame.locator('#root > *').first().waitFor();
      check(`${label}: ${id} renders content`, ((await frame.locator('#root').textContent()) ?? '').length > 10);
      check(`${label}: ${id} shows no error state`, (await page.locator(`#${id} .error`).count()) === 0);
      check(`${label}: the frame grew to fit`, (await page.locator(`#${id} iframe`).evaluate(f => f.getBoundingClientRect().height)) > 40);
      check(`${label}: ${id} causes no horizontal scroll`, await noScroll(page));
      const inside = page.frames().find(f => f.url().includes('widget-frame'));
      const escapes = await inside.evaluate(async () => {
        const tryIt = async fn => { try { await fn(); return 'allowed'; } catch { return 'blocked'; } };
        return {
          parentDom: await tryIt(() => window.parent.document.title),
          storage: await tryIt(() => window.localStorage.length),
          network: await tryIt(() => fetch('https://example.com/?leak')),
        };
      });
      assert.deepEqual(escapes, { parentDom: 'blocked', storage: 'blocked', network: 'blocked' }, `${label}: the frame can't reach the page, storage or network`);
      assert.deepEqual(errors.filter(e => !/example\.com|Content Security Policy|Failed to fetch/.test(e)), [], `${label}: no console errors`);
      mkdirSync(SHOTS, { recursive: true });
      await page.locator(`#${id}`).screenshot({ path: `${SHOTS}/widget-${id}-${label}.png` });
    }));
  }
}
