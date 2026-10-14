// Browser smoke test of demo mode against the built dist/ (npm run build && npm run smoke).
// Needs a real browser, so it isn't part of the gate: $PW_EXECUTABLE, else the installed Edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(DIST, path.endsWith('/') ? `${path}index.html` : path);
    try { res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); }
    catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

const launch = () => chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : { channel: process.env.PW_CHANNEL ?? 'msedge' });

const check = (name, ok) => assert.ok(ok, name);

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`demo dashboard on ${label}`, async () => {
    const server = await serve();
    const browser = await launch();
    try {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('console', m => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${server.address().port}/?demo`, { waitUntil: 'networkidle' });
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
      check(`${label}: no horizontal page scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      assert.deepEqual(errors, [], `${label}: no console errors`);
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/dashboard-${label}.png`, fullPage: true });
    } finally {
      await browser.close();
      server.close();
    }
  });
}
