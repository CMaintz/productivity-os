// propose_card: the one write the MCP server allows. It only ever adds a pending card through
// cards.mjs; approving, running and undoing stay with you and the executor. Only action types
// that make sense from a chat are accepted: forge, widget and policy cards come from their own
// pipelines, and letting a client propose `promote_policy` would let it ask for its own trust.
//
// Everything a client sends is untrusted (its model may have read a hostile page), and the
// card is rendered by Obsidian with Meta Bind and Datacore on. So client text goes in as one
// plain line, and the prompt only inside a code fence, where nothing renders, runs or hides.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCard, policyFile, slug } from '../actions/cards.mjs';
import { isNever, levelFor, parsePolicy } from '../actions/policy.mjs';

export const ACTIONS = ['reminder', 'claude_task'];

// The vault's rule for claude_task prompts, added here so a proposal can't leave it out.
const GUARD = 'Work on a branch. Never push to main, never merge, never delete anything.';

// Backticks open code and Meta Bind fields, `%%` and `<` hide text in reading view.
const plain = s => String(s ?? '').replace(/[`<>]|%%/g, '').replace(/\s+/g, ' ').trim();

function fence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}text\n${text}\n${ticks}`;
}

// A drive path on Windows: cmd.exe can't start in a UNC folder and silently uses C:\Windows.
const isLocalDir = cwd => path.isAbsolute(cwd) && (process.platform !== 'win32' || /^[a-z]:/i.test(cwd))
  && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();

function taskParams({ cwd, prompt } = {}) {
  if (!cwd || !isLocalDir(cwd)) return { error: 'claude_task needs params.cwd: an existing folder on this PC, as an absolute drive path.' };
  if (!prompt?.trim()) return { error: 'claude_task needs params.prompt: self-contained instructions for an unattended session.' };
  const full = `${prompt.trim()}\n\n${GUARD}`;
  return { params: { cwd, prompt: full }, explain: `a Claude Code session runs with this folder and prompt:\n\n${fence(`${cwd}\n\n${full}`)}\n` };
}

const reminder = () => ({ params: {}, explain: 'nothing runs. This is a reminder.' });

// Derived, not client-chosen, so "never suggest this" sticks; the hash keeps titles with no
// ASCII letters (Danish, emoji) from all collapsing into one key.
const keyFor = (action, title) => `mcp:${action}:${slug(title).slice(0, 40)}:${crypto.createHash('sha256').update(title).digest('hex').slice(0, 8)}`;

/** The card spec for a proposal, or `{ error }`. */
function specFor(input) {
  const body = input.action === 'claude_task' ? taskParams(input.params) : reminder();
  if (body.error) return body;
  const title = plain(input.title);
  const { action, risk = 'low', context = '' } = input;
  return { action, key: keyFor(action, title), title, reason: plain(input.reason), risk, context: plain(context), params: body.params, explain: body.explain };
}

/**
 * The policy, or null when the file exists but isn't a whole policy. The executor rewrites it
 * in place each pass, so a read can land mid-write; an empty never list would then let
 * anything through.
 */
function vettedPolicy(vault) {
  if (!fs.existsSync(policyFile(vault))) return parsePolicy('');
  const text = fs.readFileSync(policyFile(vault), 'utf8');
  return /^## Never suggest/m.test(text) ? parsePolicy(text) : null;
}

/** Creates the pending card. Returns `{ key, level, file }` or `{ error }` with the reason. */
export function proposeCard(vault, input, now) {
  const spec = specFor(input);
  if (spec.error) return spec;
  const policy = vettedPolicy(vault);
  if (!policy) return { error: '_system/policy.md is unreadable or being rewritten; try again in a minute.' };
  if (isNever(policy, spec)) return { error: `Refused: \`${spec.action}\` or this card's key is on the Never suggest list in _system/policy.md.` };
  const file = createCard(vault, spec, now.toISOString(), { ask: true, policy });
  if (!file) return { error: `Skipped: an open card with key \`${spec.key}\` already exists.` };
  return { key: spec.key, level: levelFor(policy, spec.action), file: path.relative(vault, file).split(path.sep).join('/') };
}
