#!/usr/bin/env node
// Code widgets on the PC side, from request to retirement:
//   propose: the orchestrator asks for one with a build_code_widget card
//   ticket:  approving it opens an agent-feature issue (agent:ready + widget:code) for /feature
//   install: once CI auto-merges the PR, its manifest lands in the vault with a notice card
//   off-switch: repeated runtime errors on the dashboard disable it and propose a fix ticket
// GitHub goes through the `gh` CLI on the user's login; nothing here needs an API key.
//
// CLI: node tools/widgets/code-widgets.mjs propose '<json {id,title,purpose,source,fields}>' [--vault <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { createIssue, ensureLabels, gh } from '../lib/gh.mjs';
import { CODE_VIEW, ID_PATTERN, fieldsUsed, validateManifest } from './manifest.mjs';
import { readLayout, writeLayout, WIDGETS_DIR } from './widgets.mjs';
import { createCard } from '../actions/cards.mjs';
import { readToolsConfig } from '../lib/tools-config.mjs';
import { vaultFromArgs } from '../lib/cli.mjs';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

const DEFAULT_REPO = 'CMaintz/productivity-os';
// Outside _system/widgets/, where every .json is read as a manifest.
const INSTALLED_FILE = path.join('_system', 'code-widgets-installed.json');
const ERROR_LIMIT = 3;
const ERROR_WINDOW_H = 24;

export const repoOf = vault => readToolsConfig(vault).githubRepo || DEFAULT_REPO;


/** The manifest a requested widget will ship with, permissions derived from what it reads. */
export function draftManifest({ id, title, source, fields = [] }) {
  const m = { id, title, view: `code:${id}`, size: 'm', fields, source };
  return { ...m, permissions: { collections: source?.kind === 'snapshot' ? [source.collection] : [], ...(source?.kind === 'notes' ? { folders: [source.folder] } : {}), fields: fieldsUsed(m), connectors: [] } };
}

export function proposeCodeWidget(vault, spec, now = new Date().toISOString()) {
  if (typeof spec?.purpose !== 'string' || !spec.purpose.trim()) return { errors: ['purpose is required: what the widget is for'] };
  const manifest = draftManifest(spec);
  const errors = validateManifest(manifest);
  if (errors.length) return { errors };
  const file = createCard(vault, {
    action: 'build_code_widget', key: `code-widget:${spec.id}`, risk: 'low',
    title: `Build a "${spec.title}" widget`, reason: spec.purpose,
    explain: `opens an agent ticket in ${repoOf(vault)}. An agent builds it on a branch with tests; if CI and the permission guard pass, it merges and deploys itself, and a notice card appears here.`,
    undo: 'close the ticket on GitHub before the agent picks it up; after it ships, Undo on the notice card removes it.',
    params: { spec: { id: spec.id, title: spec.title, purpose: spec.purpose }, manifest },
  }, now);
  return { file };
}

const CONTRACT = `- Lives in \`dashboard/src/widgets/code/<id>/\`: \`widget.ts\` (\`createWidget(host)\` returning \`({ m, rows, ctx }) => VNode\`, built with \`host.h\`), \`widget.json\` (the manifest below, unchanged unless the data truly needs it) and \`fixture.json\` (\`{ rows, expect }\`: sample rows and strings the render must contain).
- Run \`node tools/widgets/code-registry.mjs\` after adding the folder.
- It renders in a sandboxed iframe from the rows it's given: no network, storage or DOM globals, and no imports beyond \`../../types\`, \`../../format\` and its own folder (ESLint enforces this). Style with the dashboard's classes or inline \`style\`.`;

/** The agent-feature ticket body for a requested code widget. */
export function ticketBody({ spec, manifest }) {
  return `### Intent
As the owner, I want a "${spec.title}" widget on my dashboard: ${spec.purpose}

### Acceptance criteria
- [ ] \`dashboard/src/widgets/code/${spec.id}/\` follows the code widget contract (docs/VAULT.md section 10):
${CONTRACT}
- [ ] \`node tools/widgets/guard.mjs\` passes: nothing outside the widget folder and generated files changes, and \`permissions\` match what it reads.
- [ ] \`mise run gate\` is green and the smoke test renders it at \`?demo&widget=${spec.id}\` on desktop and phone without console errors.

### Scope boundaries
- Only this widget's folder plus the two generated files. Anything else means the PR needs review, not auto-merge.
- No new data: the manifest below is the data it gets.

### Pointers
- Manifest:
\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`
- Example: \`dashboard/src/widgets/code/ci-status/\`.
`;
}

function openIssue(ctx, { title, body }) {
  const repo = repoOf(ctx.vault);
  ensureLabels(ctx.gh, repo, ['agent:ready', 'widget:code', 'widget:needs-review']);
  return createIssue(ctx.gh, repo, { title, body, labels: ['agent:ready', 'widget:code'] });
}

/** build_code_widget handler: opens the ticket the /feature loop picks up. */
export function openBuildTicket(card, ctx) {
  const { spec, manifest } = card.params;
  if (!ID_PATTERN.test(String(spec?.id)) || validateManifest(manifest).length) return { ok: false, summary: 'The requested widget is no longer valid; propose it again.' };
  const url = openIssue(ctx, { title: `feat(widget): ${spec.title}`, body: ticketBody({ spec, manifest }) });
  return { ok: true, summary: `Opened ${url}. An agent picks it up; when it ships, a notice card appears here.` };
}

/** fix_widget handler: a ticket to repair a widget the off-switch disabled. */
export function openFixTicket(card, ctx) {
  const { id, errors = [] } = card.params;
  const names = [...new Set(errors.map(e => String(e).split(':')[0].replace(/[^\w]/g, '').slice(0, 40)))];
  if (!ID_PATTERN.test(String(id))) return { ok: false, summary: `Refused: "${id}" isn't a widget id.` };
  const body = `### Intent\nThe \`${id}\` code widget kept crashing on the dashboard and was switched off. Fix it so it renders again.\n\n### Acceptance criteria\n- [ ] The crash can't happen again; \`fixture.json\` gains rows that reproduce it.\n- [ ] \`node tools/widgets/guard.mjs\` passes and \`mise run gate\` is green.\n\n### Scope boundaries\n- Only \`dashboard/src/widgets/code/${id}/\` and the generated files.\n\n### Pointers\n- Error types: ${names.map(n => `\`${n}\``).join(', ') || '(none recorded)'}. The messages can quote row data, so they stay in the vault: \`_system/actions/\` fix card for \`${id}\`.\n`;
  const url = openIssue(ctx, { title: `fix(widget): ${id} keeps crashing`, body });
  return { ok: true, summary: `Opened ${url}. The widget stays off until the fix ships.` };
}

// ---------- after CI merges a widget PR ----------

const readInstalled = vault => {
  try { return JSON.parse(fs.readFileSync(path.join(vault, INSTALLED_FILE), 'utf8')); } catch { return { prs: [] }; }
};
const WIDGET_JSON = /^dashboard\/src\/widgets\/code\/([a-z0-9][a-z0-9-]{0,40})\/widget\.json$/;

/** The widget's manifest on main; null only when GitHub says it's gone (404). Other failures throw. */
function manifestOnMain(run, repo, id) {
  try {
    const out = run(['api', `repos/${repo}/contents/dashboard/src/widgets/code/${id}/widget.json?ref=main`, '--jq', '.content']);
    return JSON.parse(Buffer.from(out.trim(), 'base64').toString('utf8'));
  } catch (e) {
    if (/\b404\b|Not Found/.test(`${e.message} ${e.stderr ?? ''}`)) return null;
    throw e;
  }
}

/**
 * Merged widget:code PRs not seen before: each changed widget's manifest from main becomes an
 * install_code_widget card (auto-notice, with Undo). A widget gone from main is removed here too.
 */
export function installMerged(vault, { run = gh, now = new Date().toISOString() } = {}) {
  const repo = repoOf(vault);
  const seen = readInstalled(vault);
  const prs = JSON.parse(run(['pr', 'list', '--repo', repo, '--state', 'merged', '--label', 'widget:code', '--limit', '30', '--json', 'number,title,files']));
  const out = [];
  const handled = new Set();
  // Oldest first, and each widget once per pass: main's current manifest is what gets installed.
  for (const pr of prs.filter(p => !seen.prs.includes(p.number)).reverse()) {
    const ids = [...new Set((pr.files ?? []).map(f => WIDGET_JSON.exec(f.path)?.[1]).filter(Boolean))].filter(id => !handled.has(id));
    let manifests;
    try { manifests = ids.map(id => [id, manifestOnMain(run, repo, id)]); } catch (e) { out.push(`retry #${pr.number} later: ${e.message.split('\n')[0]}`); continue; }
    for (const [id, manifest] of manifests) {
      handled.add(id);
      if (!manifest) { out.push(removeFromVault(vault, id)); continue; }
      const file = createCard(vault, {
        action: 'install_code_widget', key: `install:${id}:${pr.number}`, risk: 'low',
        title: `New widget: ${manifest.title}`, reason: `PR #${pr.number} (${pr.title}) passed CI and the permission guard, merged and deployed.`,
        explain: `adds \`${id}\` to the dashboard layout.`, undo: 'press Undo: it leaves the dashboard at once, and a card offers to remove its code.',
        params: { manifest, pr: pr.number },
      }, now);
      out.push(file ? `install ${id}` : `skipped ${id}`);
    }
    seen.prs.push(pr.number);
  }
  fs.mkdirSync(path.dirname(path.join(vault, INSTALLED_FILE)), { recursive: true });
  writeFileAtomic(path.join(vault, INSTALLED_FILE), JSON.stringify(seen, null, 2) + '\n');
  return out;
}

function removeFromVault(vault, id) {
  fs.rmSync(path.join(vault, WIDGETS_DIR, `${id}.json`), { force: true });
  const layout = readLayout(vault);
  writeLayout(vault, { ...layout, widgets: layout.widgets.filter(w => w.id !== id) });
  return `removed ${id}`;
}

/** install_code_widget handler: writes (or updates) the manifest and (re-)enables it in the layout. */
export function installWidget(card, ctx) {
  const m = card.params.manifest;
  const errors = validateManifest(m);
  if (errors.length || !CODE_VIEW.test(m.view)) return { ok: false, summary: `Invalid manifest: ${errors.join('; ') || 'not a code widget'}` };
  const file = path.join(ctx.vault, WIDGETS_DIR, `${m.id}.json`);
  const isNew = !fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(m, null, 2) + '\n');
  const layout = readLayout(ctx.vault);
  const since = ctx.now.toISOString();
  const entry = layout.widgets.find(w => w.id === m.id);
  const widgets = entry ? layout.widgets.map(w => (w.id === m.id ? { ...w, disabled: false, since } : w)) : [...layout.widgets, { id: m.id, since }];
  writeLayout(ctx.vault, { ...layout, widgets });
  return { ok: true, summary: `\`${m.id}\` is live on the dashboard${isNew ? '' : ' (updated, switched back on)'}.`, undo: { removeWidget: m.id, removeCode: true } };
}

/** After an Undo: offer to take the code out of the repo too (a Claude task opening a widget:code PR). */
export function proposeCodeRemoval(vault, id, now = new Date().toISOString()) {
  const repoDir = readToolsConfig(vault).productivityOs;
  if (!repoDir) return null;
  return createCard(vault, {
    action: 'claude_task', key: `remove-code-widget:${id}`, risk: 'low',
    title: `Remove the ${id} widget's code`, reason: `You undid the ${id} widget; its code is still in the repo.`,
    explain: 'Claude deletes the folder, regenerates the registry, and opens a widget:code PR that merges itself once CI passes.',
    params: { cwd: repoDir, prompt: `Remove the code widget "${id}": git switch -c remove-widget-${id} origin/main, delete dashboard/src/widgets/code/${id}/, run node tools/widgets/code-registry.mjs, run mise run gate, commit, push, and gh pr create --label widget:code --title "revert(widget): remove ${id}" --body "Undo from the dashboard."` },
  }, now);
}

// ---------- runtime off-switch ----------

/**
 * `errors` are recent dashboard reports ({ widget_id, message, created_at }). A widget with
 * ERROR_LIMIT of them since it was (re)enabled, within the window, is switched off and gets a fix card.
 */
export function applyWidgetErrors(vault, errors, now = new Date()) {
  const layout = readLayout(vault);
  const windowStart = new Date(now.valueOf() - ERROR_WINDOW_H * 36e5).toISOString();
  const off = [];
  const widgets = layout.widgets.map(w => {
    if (w.disabled) return w;
    const since = [windowStart, w.since ?? ''].sort().pop();
    const mine = errors.filter(e => e.widget_id === w.id && e.created_at > since);
    if (mine.length < ERROR_LIMIT) return w;
    off.push({ id: w.id, errors: mine.map(e => e.message).slice(-5).reverse() });
    return { ...w, disabled: true };
  });
  if (!off.length) return [];
  writeLayout(vault, { ...layout, widgets });
  for (const { id, errors: msgs } of off) {
    createCard(vault, {
      action: 'fix_widget', key: `fix-widget:${id}`, risk: 'low', title: `Fix the ${id} widget`,
      reason: `It crashed ${ERROR_LIMIT}+ times in ${ERROR_WINDOW_H}h on the dashboard, so it's switched off.`,
      explain: 'opens an agent ticket to fix it; the fix ships through the same guarded PR flow and switches it back on.',
      undo: `to switch it back on without a fix, set "disabled": false for ${id} in _system/layouts/dashboard.json.`,
      params: { id, errors: msgs },
    }, now.toISOString());
  }
  return off.map(o => o.id);
}

function main() {
  const [cmd, json] = process.argv.slice(2);
  const vault = vaultFromArgs();
  if (cmd !== 'propose' || !json) { console.error("Usage: code-widgets.mjs propose '<json {id,title,purpose,source,fields}>' [--vault <dir>]"); process.exit(2); }
  const r = proposeCodeWidget(vault, JSON.parse(json));
  if (r.errors) { console.error(`Can't propose it:\n- ${r.errors.join('\n- ')}`); process.exit(1); }
  console.log(r.file ? `Proposed as ${path.relative(vault, r.file)}` : 'Skipped: an open card for this widget exists, or it is on the never list.');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'code-widgets.mjs') main();
