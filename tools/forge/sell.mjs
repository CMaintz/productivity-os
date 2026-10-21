// The Forge's sell-or-hand-over stage (slice 5), after you approve the sell card on a demoed product.
// Everything is a draft for you: nothing is published, listed or sent.
//   facts   code, not a model, from a fresh checkout of main and the forge's state: the secrets
//           inventory (names and where they're used, never values), a license audit of production
//           dependencies, known issues, and a transfer checklist.
//   drafts  a detached `claude -p` writes the landing page, one-pager, pitch outline, video
//           script, listing, architecture and runbook into forge-pack/, with no web, gh, git or
//           wrangler, without your credentials, and writing only that folder.
//   pack    Forge/<slug>/pack/ (handover/ for the new owner's files): only real .md files from
//           forge-pack/ are copied, with secret-looking values and your .env values redacted,
//           and every file is marked as a draft.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCard } from '../actions/cards.mjs';
import { save } from './state.mjs';
import { candidates } from './stages.mjs';
import { addSpend, insideFile, prepareWorktree, sandboxEnv, startRun, workerStatus } from './workers.mjs';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const SALES = ['landing', 'one-pager', 'pitch', 'video-script', 'listing'];
const HANDOVER = ['architecture', 'runbook'];
const DRAFTS = [...SALES, ...HANDOVER];
const PACK_TOOLS = 'Read,Glob,Grep,Write(forge-pack/**),Edit(forge-pack/**)';
const DRAFT_MARK = '> DRAFT: not published. Written by the Product Forge for you to review.\n\n';
const PERMISSIVE = /^(MIT|Apache-2\.0|BSD(-[\w.-]+)?|ISC|0BSD|Unlicense)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.astro', '.wrangler', 'coverage', 'forge-pack', 'forge-demo']);
const CODE = /\.([cm]?[jt]sx?|astro|svelte|vue)$/;
const ENV_USES = [/process\.env\.([A-Z_][A-Z0-9_]*)/g, /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g, /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g];
const ENV_EXAMPLES = ['.env.example', '.dev.vars.example'];
const ENV_FILES = ['.env', '.env.local', '.env.production', '.dev.vars'];
// Shapes of common secrets; anything matching is redacted from the drafts.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk_(live|test)_[A-Za-z0-9]{16,}/g, /\bsk-[A-Za-z0-9_-]{20,}/g, /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bgithub_pat_\w{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
];
const MAX_ATTEMPTS = 2;
const HOUR = 36e5;

const firstLine = e => String(e?.message || e).split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 200) ?? 'unknown error';
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const readIf = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    else if (e.isFile()) out.push(path.join(dir, e.name));
  }
  return out;
}

function wranglerConfig(wt) {
  const json = readIf(path.join(wt, 'wrangler.jsonc')) || readIf(path.join(wt, 'wrangler.json'));
  if (json) { try { return JSON.parse(json.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')); } catch { return {}; } }
  const toml = readIf(path.join(wt, 'wrangler.toml'));
  const vars = (toml.split(/^\[vars\]\s*$/m)[1] ?? '').split(/^\[/m)[0];
  return { name: toml.match(/^name\s*=\s*"([^"]+)"/m)?.[1], vars: Object.fromEntries([...vars.matchAll(/^([A-Za-z_][\w]*)\s*=/gm)].map(m => [m[1], ''])) };
}

/** Every environment variable and secret the product uses, by name: name -> where. Never values. */
export function secretNames(wt) {
  const names = new Map();
  const add = (n, where) => (names.get(n) ?? names.set(n, new Set()).get(n)).add(where);
  for (const file of walk(wt).filter(f => CODE.test(f))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of ENV_USES) for (const m of text.matchAll(re)) add(m[1], rel(wt, file));
  }
  for (const ex of ENV_EXAMPLES) for (const m of readIf(path.join(wt, ex)).matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)) add(m[1], ex);
  for (const n of Object.keys(wranglerConfig(wt).vars ?? {})) add(n, 'wrangler config (vars)');
  return names;
}

const permissive = license => String(license).replace(/[()]/g, '').split(/\s+OR\s+/i).some(alt => alt.split(/\s+AND\s+/i).every(l => PERMISSIVE.test(l.trim())));

/** Production dependencies from package-lock.json with their license, flagging the ones to check. */
export function licenses(wt) {
  let lock;
  try { lock = JSON.parse(readIf(path.join(wt, 'package-lock.json'))); } catch { return null; }
  return Object.entries(lock.packages ?? {}).filter(([k, v]) => k && !v.dev)
    .map(([k, v]) => ({ name: k.replace(/^.*node_modules\//, ''), license: String(v.license ?? 'unknown'), ok: permissive(v.license ?? '') }))
    .sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));
}

function facts(f, b, wt) {
  const secrets = secretNames(wt);
  const deps = licenses(wt);
  const issues = [...(b.verify?.accepted ?? []).map(t => `Open finding you accepted: ${t}`), ...(b.verify?.low ?? []).map(t => `Low finding: ${t}`), ...(b.demo?.gaps ?? []).map(t => `Demo: ${t}`)];
  const names = candidates(readIf(path.join(f.dir, 'naming.md'))).slice(0, 3);
  const worker = wranglerConfig(wt).name;
  const secretRows = [...secrets].sort(([a], [c]) => a.localeCompare(c)).map(([n, where]) => `| ${n} | ${[...where].join(', ')} |`);
  return {
    'secrets-inventory': `# ${b.name}: secrets inventory\nNames only: the values live wherever you keep them (Cloudflare, Supabase, your .env), never here.\n\n| Name | Used in |\n|---|---|\n${secretRows.join('\n') || '| (none found) | |'}\n`,
    'license-audit': `# ${b.name}: license audit\nProduction dependencies from package-lock.json. "check" means not plainly permissive: read its license before selling.\n\n${deps ? `| Package | License | |\n|---|---|---|\n${deps.map(d => `| ${d.name} | ${d.license} | ${d.ok ? 'fine' : 'check'} |`).join('\n')}` : 'No package-lock.json found.'}\n`,
    'known-issues': `# ${b.name}: known issues\n${issues.length ? issues.map(i => `- ${i}`).join('\n') : '- None recorded by verify or the demo.'}\n`,
    'transfer-checklist': `# ${b.name}: transfer checklist\nEach step is yours to do; the forge does none of them.\n\n- [ ] Transfer the repo https://github.com/${b.repo} (GitHub → Settings → Transfer ownership).\n- [ ] Domain: ${names.length ? `the name candidates were ${names.join(', ')}; transfer whichever one you registered` : 'transfer the domain, if you registered one'}.\n- [ ] Cloudflare: hand over or recreate the Worker${worker ? ` \`${worker}\`` : ''} in the buyer's account, and delete the demo preview.\n- [ ] Secrets: the buyer sets their own values for ${[...secrets.keys()].sort().join(', ') || 'none found'}; rotate every one you used.\n- [ ] Accounts: move or close any service accounts (Supabase project, email provider, payments).\n- [ ] Hand over this pack and the known issues.\n`,
  };
}

function factsBrief(fx) {
  return Object.values(fx).map(t => t.split('\n').filter(l => !l.startsWith('# ')).join('\n')).join('\n');
}

function startDrafts(f, b, ctx, p) {
  const demo = readIf(path.join(f.dir, 'demo.md'));
  const vars = { NAME: b.name, REPO: b.repo, PREVIEW: b.demo?.preview?.url ?? 'none (local only)', DEMO: demo.slice(0, 6000), FACTS: factsBrief(facts(f, b, p.wt)).slice(0, 8000), FILES: DRAFTS.map(n => `forge-pack/${n}.md`).join(', ') };
  const prompt = Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), fs.readFileSync(path.join(PROMPTS, 'sell-pack.md'), 'utf8'));
  const env = sandboxEnv(path.join(ctx.logDir, 'sell-sandbox'));
  return startRun({ prompt, cwd: p.wt, tools: PACK_TOOLS, logDir: ctx.logDir, name: 'sell-pack', now: ctx.now, env, sys: ctx.sys });
}

/** A draft's text when it is a real .md file in forge-pack/ with a title, else null. */
function draftOf(wt, name) {
  let root;
  try { root = fs.realpathSync(path.join(wt, 'forge-pack')); } catch { return null; }
  const real = insideFile(path.join(root, `${name}.md`), root);
  const text = real ? fs.readFileSync(real, 'utf8') : '';
  return /^# \S/m.test(text) ? text : null;
}

/** The text with secret-looking values and the repo's .env values replaced; and how many were. */
export function redact(text, wt) {
  const envValues = ENV_FILES.flatMap(e => [...readIf(path.join(wt, e)).matchAll(/^[A-Za-z_]\w*\s*=\s*["']?(.+?)["']?\s*$/gm)].map(m => m[1])).filter(v => v.length >= 6);
  let n = 0;
  let out = text;
  for (const v of envValues) {
    const parts = out.split(v);
    n += parts.length - 1;
    out = parts.join('[redacted]');
  }
  for (const re of SECRET_SHAPES) out = out.replace(re, () => ((n += 1), '[redacted]'));
  return { text: out, redacted: n };
}

function pack(vault, f, b, ctx, p) {
  const out = path.join(f.dir, 'pack');
  fs.mkdirSync(path.join(out, 'handover'), { recursive: true });
  let redacted = 0;
  const written = [];
  const missing = [];
  for (const name of DRAFTS) {
    const text = draftOf(p.wt, name);
    if (!text) { missing.push(name); continue; }
    const r = redact(text, p.wt);
    redacted += r.redacted;
    const to = path.join(HANDOVER.includes(name) ? 'handover' : '', `${name}.md`);
    fs.writeFileSync(path.join(out, to), DRAFT_MARK + r.text);
    written.push(to.split(path.sep).join('/'));
  }
  for (const [name, text] of Object.entries(facts(f, b, p.wt))) {
    fs.writeFileSync(path.join(out, 'handover', `${name}.md`), DRAFT_MARK + text);
    written.push(`handover/${name}.md`);
  }
  createCard(vault, {
    action: 'reminder', key: `forge-packed:${b.slug}`, risk: 'low', title: `Forge ${b.name}: sell and handover pack ready`,
    reason: `Drafts in [[Forge/${b.slug}/pack]]: ${written.join(', ')}.${missing.length ? ` missing: ${missing.join(', ')}.` : ''}${redacted ? ` Redacted ${redacted} secret-looking value${redacted === 1 ? '' : 's'}.` : ''}${p.failure ? ` The drafting run failed: ${p.failure}.` : ''} Nothing was published, listed or sent: those steps are yours.`,
    context: `https://github.com/${b.repo}`, explain: 'nothing runs; this is the last Forge stage.', params: {},
  }, ctx.now.toISOString());
  save(f, { stage: 'packed', status: 'done' }, ctx.now, `sell: pack ready (${written.length} files${missing.length ? `, missing ${missing.join(', ')}` : ''})`);
  return `sell: pack ready (${written.length} files)`;
}

/** One sell pass: collect the drafting run (retrying a missing draft once, waiting out a usage stop), start it, then pack. */
export function sellStep(vault, f, b, ctx) {
  const p = (b.sell ??= { attempts: 0 });
  const log = [];
  try {
    if (!p.wt) { p.wt = prepareWorktree(ctx.sys, b.clone, 'pack', 0, { fromMain: true }); ctx.persist(); }
    if (p.run && !p.ready) {
      let s = workerStatus(p.run, { now: ctx.now, sys: ctx.sys });
      if (s === 'running') return log;
      addSpend(b, s);
      if (s === 'timeout') { ctx.sys.kill(p.run.pid); s = { ok: false, text: 'no result after the time limit' }; }
      p.run = null;
      if (s.usageLimit) {
        p.retryAfter = new Date(ctx.now.valueOf() + HOUR).toISOString();
        log.push(`sell: drafting hit the usage limit; trying again at ${p.retryAfter}`);
        return log;
      }
      const missing = DRAFTS.filter(n => !draftOf(p.wt, n));
      if (missing.length && ++p.attempts < MAX_ATTEMPTS) log.push(`sell: ${missing.join(', ')} missing; retrying`);
      else Object.assign(p, { ready: true, failure: s.ok ? null : firstLine(s.text) });
      ctx.persist();
    }
    if (!p.ready && !p.run) {
      if (p.retryAfter && new Date(p.retryAfter) > ctx.now) return log;
      Object.assign(p, { run: startDrafts(f, b, ctx, p), retryAfter: null });
      ctx.persist();
      if (!p.attempts) log.push('sell: drafting the sell and handover pack');
      return log;
    }
    if (p.ready) log.push(pack(vault, f, b, ctx, p));
  } catch (e) {
    log.push(`sell: error, trying again next pass: ${firstLine(e)}`);
  }
  return log;
}
