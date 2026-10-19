// What each action type does when its card is approved. Each handler gets the card and a
// context ({ vault, now, runClaude, gh, policy }) and returns { ok, summary, undo? }. `undo`, when
// present, is stored on the card so the Undo button can reverse the action exactly.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFrontmatter, setFrontmatter } from '../lib/frontmatter.mjs';
import { promote } from './policy.mjs';
import { ID_PATTERN, validateManifest } from '../widgets/manifest.mjs';
import { readLayout, writeLayout } from '../widgets/widgets.mjs';
import { installWidget, openBuildTicket, openFixTicket, proposeCodeRemoval } from '../widgets/code-widgets.mjs';
import { createForgeRepo } from '../forge/repo.mjs';
import { mergeTicketPr } from '../forge/build.mjs';

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

/** Writes the approved manifest and appends it to the dashboard layout. */
function createWidget(card, ctx) {
  const m = card.params.manifest;
  const errors = validateManifest(m);
  if (errors.length) return { ok: false, summary: `Invalid manifest: ${errors.join('; ')}` };
  const file = path.join(ctx.vault, '_system', 'widgets', `${m.id}.json`);
  if (fs.existsSync(file)) return { ok: false, summary: `A widget named \`${m.id}\` already exists.` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  const layout = readLayout(ctx.vault);
  if (!layout.widgets.some(w => w.id === m.id)) layout.widgets.push({ id: m.id });
  writeLayout(ctx.vault, layout);
  return { ok: true, summary: `Added widget \`${m.id}\` to the dashboard.`, undo: { removeWidget: m.id } };
}

function removeWidget(vault, id) {
  if (!ID_PATTERN.test(String(id))) return { ok: false, summary: `Refused: "${id}" isn't a widget id.` };
  fs.rmSync(path.join(vault, '_system', 'widgets', `${id}.json`), { force: true });
  const layout = readLayout(vault);
  writeLayout(vault, { ...layout, widgets: layout.widgets.filter(w => w.id !== id) });
  return { ok: true, summary: `Removed widget \`${id}\` and its layout entry.` };
}

export const HANDLERS = {
  create_widget: createWidget,
  build_code_widget: openBuildTicket,
  install_code_widget: installWidget,
  fix_widget: openFixTicket,
  forge_create_repo: createForgeRepo,
  forge_merge_pr: mergeTicketPr,
  forge_question: () => ({ ok: true, summary: 'The forge passes your answer to the ticket on its next pass.' }),
  // The forge reads these cards' outcome on its next step (tools/forge/forge.mjs).
  forge_review: () => ({ ok: true, summary: 'The forge continues on its next pass.' }),
  forge_questions: () => ({ ok: true, summary: 'Thanks; the forge writes the spec on its next pass.' }),
  forge_demo: () => ({ ok: true, summary: 'The forge makes the preview and the tour on its next pass.' }),
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

/** Reverses an action that stored an exact undo (a field edit or an added widget). Others need a manual undo. */
export function undoAction(card, ctx) {
  const u = card.undo;
  if (u?.removeWidget) {
    const r = removeWidget(ctx.vault, u.removeWidget);
    if (r.ok && u.removeCode && proposeCodeRemoval(ctx.vault, u.removeWidget, ctx.now.toISOString())) r.summary += ' A card offers to remove its code from the repo.';
    return r;
  }
  if (!u?.file) return { ok: false, summary: 'No automatic undo for this action; follow the Undo line above.' };
  const full = path.join(ctx.vault, u.file);
  fs.writeFileSync(full, setFrontmatter(fs.readFileSync(full, 'utf8'), u.key, u.value));
  return { ok: true, summary: `Restored \`${u.key}: ${u.value}\` in [[${u.file.replace(/\.md$/, '')}]].` };
}
