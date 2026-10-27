#!/usr/bin/env node
// Builds dashboard/public/widget-frame.js: the code widgets plus Preact, for widget-frame.html,
// which the dashboard loads in a sandboxed iframe (allow-scripts only: an opaque origin with no
// access to the dashboard's session or storage, and a CSP with no network). A classic script with
// the dashboard's CSS inlined, because an opaque-origin page can't load module scripts or
// stylesheets from the dashboard without CORS. Run by the dashboard's dev and build scripts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard');
const css = fs.readFileSync(path.join(DASH, 'src', 'styles', 'dashboard.css'), 'utf8') + '\nbody.widget-frame { background: transparent; }\n';

await build({
  entryPoints: [path.join(DASH, 'src', 'widgets', 'frame.ts')],
  outfile: path.join(DASH, 'public', 'widget-frame.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  banner: { js: `document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(css)} }));` },
});
console.log('wrote dashboard/public/widget-frame.js');
