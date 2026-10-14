// What each action type does when its card is approved. Each handler gets the card and a
// context ({ vault, runClaude, policy }) and returns { ok, summary, undo? }. `undo`, when
// present, is stored on the card so the Undo button can reverse the action exactly.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFrontmatter, setFrontmatter } from '../lib/frontmatter.mjs';
import { promote } from './policy.mjs';

const MAX_SUMMARY = 1500;
const TIMEOUT_MS = 30 * 60 * 1000;

// Tools an unattended session may use. Repo work gets git/gh/npm/mise/node through Bash;
// vault work only edits files. Permission mode acceptEdits, so nothing else is allowed.
const REPO_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(gh:*),Bash(npm:*),Bash(npx:*),Bash(mise:*),Bash(node:*)';
const VAULT_TOOLS = 'Read,Edit,Write,Glob,Grep';

const winQuote = a => (/[\s,()*&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * Runs `claude -p` on the user's subscription, with the prompt on stdin. $CLAUDE_BIN
 * overrides the binary. On Windows the npm shim is a .cmd, so it goes through the shell.
 */
export function runClaude(prompt, cwd, allowedTools) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', allowedTools];
  const win = process.platform === 'win32';
  const r = spawnSync(bin, win ? args.map(winQuote) : args, { cwd, input: prompt, encoding: 'utf8', timeout: TIMEOUT_MS, shell: win });
  if (r.error || r.status !== 0) return { ok: false, text: String(r.error?.message || r.stderr || `exit ${r.status}`).trim() };
  try {
    const out = JSON.parse(r.stdout);
    return { ok: !out.is_error, text: String(out.result ?? ''), sessionId: out.session_id };
  } catch {
    return { ok: true, text: r.stdout.trim() };
  }
}

const short = s => (s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY)}…` : s);

function claudeIn(cwd, tools) {
  return (card, ctx) => {
    if (!cwd(card, ctx) || !fs.existsSync(cwd(card, ctx))) return { ok: false, summary: `Folder not found: ${cwd(card, ctx)}` };
    const r = ctx.runClaude(card.params.prompt, cwd(card, ctx), tools);
    return { ok: r.ok, summary: short(r.text || '(no output)'), sessionId: r.sessionId };
  };
}

function setField(card, ctx) {
  const { file, key, value } = card.params;
  const full = path.join(ctx.vault, file);
  if (!fs.existsSync(full)) return { ok: false, summary: `Note not found: ${file}` };
  const note = fs.readFileSync(full, 'utf8');
  const previous = readFrontmatter(note).fields[key] ?? '';
  fs.writeFileSync(full, setFrontmatter(note, key, value));
  return { ok: true, summary: `Set \`${key}: ${value}\` in [[${file.replace(/\.md$/, '')}]] (was \`${previous}\`).`, undo: { file, key, value: previous } };
}

export const HANDLERS = {
  fix_ci: claudeIn(card => card.params.cwd, REPO_TOOLS),
  claude_task: claudeIn(card => card.params.cwd, REPO_TOOLS),
  triage_inbox: claudeIn((_card, ctx) => ctx.vault, VAULT_TOOLS),
  pause_stale_project: setField,
  reminder: () => ({ ok: true, summary: 'Acknowledged.' }),
  promote_policy: (card, ctx) => {
    ctx.policy = promote(ctx.policy, card.params.action, card.params.to);
    return { ok: true, summary: `\`${card.params.action}\` is now \`${card.params.to}\`.` };
  },
};

/** Reverses an action that stored an exact undo (set_field style). Others need a manual undo. */
export function undoAction(card, ctx) {
  const u = card.undo;
  if (!u?.file) return { ok: false, summary: 'No automatic undo for this action; follow the Undo line above.' };
  const full = path.join(ctx.vault, u.file);
  fs.writeFileSync(full, setFrontmatter(fs.readFileSync(full, 'utf8'), u.key, u.value));
  return { ok: true, summary: `Restored \`${u.key}: ${u.value}\` in [[${u.file.replace(/\.md$/, '')}]].` };
}
