// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';

/**
 * Astro inlines its island bootstrap scripts, which `script-src 'self'` would block. After the build,
 * hash every inline script and allow exactly those in the page CSP, instead of 'unsafe-inline'.
 * @type {import('astro').AstroIntegration}
 */
const inlineScriptHashes = {
  name: 'inline-script-hashes',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      const pages = (await readdir(dir, { recursive: true })).filter(f => f.endsWith('.html') && !f.includes('widget-frame'));
      const hashes = new Set();
      for (const page of pages) {
        for (const [, js] of (await readFile(new URL(page, dir), 'utf8')).matchAll(/<script>([\s\S]*?)<\/script>/g)) {
          hashes.add(`'sha256-${createHash('sha256').update(js).digest('base64')}'`);
        }
      }
      const file = new URL('_headers', dir);
      const headers = await readFile(file, 'utf8');
      await writeFile(file, headers.replace("script-src 'self';", `script-src 'self' ${[...hashes].join(' ')};`));
    },
  },
};

// Static site: all data comes from Supabase in the browser, behind GitHub sign-in and RLS.
export default defineConfig({
  site: 'https://dash.maintz.dev',
  output: 'static',
  devToolbar: { enabled: false },
  integrations: [preact(), inlineScriptHashes],
});
