#!/usr/bin/env node
// Action cards: one note per suggestion in _system/actions/, with Meta Bind buttons that
// only change the card's `status`. That makes them work in Obsidian on the PC and on the
// phone, and later from the web dashboard. The executor (executor.mjs) does the actual work.
//
// CLI, used by the vault's skills to propose a card:
//   node tools/actions/cards.mjs create '<json spec>' [--vault <dir>]
// spec: { action, key, title, reason, risk, context, params, explain, undo, expiresDays }

import fs from 'node:fs';
import path from 'node:path';
import { fieldsOf, setFrontmatter } from '../lib/frontmatter.mjs';
import { isNever, levelFor, parsePolicy } from './policy.mjs';
import { vaultFromArgs } from '../lib/cli.mjs';

export const ACTIONS_DIR = path.join('_system', 'actions');
export const OPEN = ['pending', 'approved', 'running', 'snoozed'];
const q = v => JSON.stringify(v ?? '');

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const addDays = (iso, days) => new Date(new Date(iso).valueOf() + days * 864e5).toISOString().slice(0, 10);

// Meta Bind buttons. Each one only sets fields on this card; nothing runs in Obsidian.
const button = (id, label, style, updates) => [
  '```meta-bind-button',
  `label: ${label}`, `id: ${id}`, 'hidden: true', `style: ${style}`, 'actions:',
  ...updates.flatMap(([k, v]) => ['  - type: updateMetadata', `    bindTarget: ${k}`, '    evaluate: false', `    value: ${v}`]),
  '```',
].join('\n');

const BUTTONS = [
  button('do-it', 'Do it', 'primary', [['status', 'approved']]),
  button('not-now', 'Not now', 'default', [['status', 'snoozed']]),
  button('no', 'No', 'destructive', [['status', 'rejected']]),
  button('always', 'Always do this', 'default', [['always', 'true'], ['status', 'approved']]),
  button('never', 'Never suggest this', 'default', [['never', 'true'], ['status', 'rejected']]),
  button('undo', 'Undo', 'default', [['status', 'undone']]),
].join('\n');

/**
 * The card note. `status` starts as pending, or approved when the policy lets this
 * action type run on its own (auto-notice / silent). Then `decided_by: policy`.
 */
export function renderCard(spec, { now, level = 'suggest' }) {
  const auto = level !== 'suggest';
  const fields = {
    type: 'action', action: spec.action, key: q(spec.key), risk: spec.risk ?? 'low',
    status: auto ? 'approved' : 'pending', reason: q(spec.reason), context: q(spec.context ?? ''),
    params: JSON.stringify(spec.params ?? {}), level, created: q(now), expires: addDays(now, spec.expiresDays ?? 7),
    decided_by: auto ? 'policy' : '""', decided_at: auto ? q(now) : '""', always: false, never: false, decline_reason: '""',
  };
  const fm = `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
  return `${fm}# ${spec.title}

**Why:** ${spec.reason}

**If you approve:** ${spec.explain ?? 'the executor carries it out on the main PC.'}

**Undo:** ${spec.undo ?? 'see the result below.'}

\`BUTTON[do-it, not-now, no]\` \`BUTTON[always, never]\`

Why not? (optional) \`INPUT[text(placeholder(a word or two)):decline_reason]\`

${BUTTONS}

## Result
`;
}

export const cardsDir = vault => path.join(vault, ACTIONS_DIR);

export function listCards(vault) {
  const dir = cardsDir(vault);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const file = path.join(dir, f); const text = fs.readFileSync(file, 'utf8');
    return { file, text, ...fieldsOf(text) };
  }).filter(c => c.type === 'action');
}

const yaml = v => (typeof v === 'string' ? q(v) : typeof v === 'object' ? JSON.stringify(v) : v);

export function updateCard(text, fields) {
  return Object.entries(fields).reduce((t, [k, v]) => setFrontmatter(t, k, yaml(v)), text);
}

export const appendResult = (text, result) => `${text.trimEnd()}\n${result.trim()}\n`;

export const policyFile = vault => path.join(vault, '_system', 'policy.md');
const readPolicy = vault => parsePolicy(fs.existsSync(policyFile(vault)) ? fs.readFileSync(policyFile(vault), 'utf8') : '');

/**
 * Creates a card unless an open one with the same key exists or the policy says never.
 * `ask` keeps it pending whatever the policy level, for proposers whose cards must always
 * wait for a click. `policy` lets a caller that has already vetted the file pass it in.
 */
export function createCard(vault, spec, now = new Date().toISOString(), { ask = false, policy = readPolicy(vault) } = {}) {
  if (isNever(policy, spec)) return null;
  if (listCards(vault).some(c => c.key === spec.key && OPEN.includes(c.status))) return null;
  fs.mkdirSync(cardsDir(vault), { recursive: true });
  const base = path.join(cardsDir(vault), `${now.slice(0, 10)}-${slug(spec.title)}`);
  let file = `${base}.md`;
  for (let i = 2; fs.existsSync(file); i++) file = `${base}-${i}.md`;
  fs.writeFileSync(file, renderCard(spec, { now, level: ask ? 'suggest' : levelFor(policy, spec.action) }));
  return file;
}

function main() {
  const [cmd, json] = process.argv.slice(2);
  const vault = vaultFromArgs();
  if (cmd !== 'create' || !json) { console.error("Usage: cards.mjs create '<json spec>' [--vault <dir>]"); process.exit(2); }
  const spec = JSON.parse(json);
  for (const k of ['action', 'key', 'title', 'reason']) if (!spec[k]) { console.error(`spec.${k} is required`); process.exit(2); }
  const file = createCard(vault, spec);
  console.log(file ? `Created ${path.relative(vault, file)}` : 'Skipped: an open card with this key exists, or it is on the never list.');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'cards.mjs') main();
