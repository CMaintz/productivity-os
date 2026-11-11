// Session notes from Claude Code's own transcripts (~/.claude/projects/<cwd>/<session>.jsonl),
// read by the executor each pass: no hook runs inside any Claude session.
// - Each file is read on from where the last pass stopped, a slice at a time; a half-written line waits.
// - A session can span files (resumed in another folder copies its earlier entries): prompts are
//   counted once by uuid, and the project is where the session started.
// - Headless runs (`claude -p`, the forge's workers) are skipped, and nothing of them is kept. A
//   sub-agent (<session>/subagents/*.jsonl) adds its tokens to its session, and nothing else.
// - Tokens are counted per API call (by message id), at the largest usage any of its lines shows:
//   Claude Code writes a line per content block with the output so far, and a resumed session
//   copies its earlier calls into the new transcript. Sub-agent transcripts that were already
//   there when this sync first read them are history and not counted.
// - New prompts also go whole into the vault's local _system/activity.jsonl for /suggest.
// The sync state lives in ~/.productivity-os/, outside the vault, so it never syncs or gets committed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFor } from '../vault/projects.mjs';
import { writeFileAtomic } from '../lib/atomic-write.mjs';

const FIRST_SYNC_DAYS = 14;
const IDLE_MIN = 30;
const WAITING_S = 60;
const FORGET_DAYS = 30;
const MAX_READ = 16 * 2 ** 20;
const PREVIEW = 160;
const MAX_PROMPTS = 50;

const oneLine = (s, n = PREVIEW) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const q = s => JSON.stringify(s ?? '');
const textOf = c => (Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join('\n') : String(c ?? '')).trim();
// Text Claude Code adds in your name: an interrupt, or a local command's output. Your turn again.
const isStop = t => t.startsWith('[Request interrupted') || t.startsWith('<local-command-stdout>');

/** What an entry tells us: a prompt (with its text), a tool call (its name), a tool result, a reply, a stop; or nothing. */
function kindOf(e) {
  if (e.type === 'assistant') {
    const tool = (Array.isArray(e.message?.content) ? e.message.content : []).find(x => x?.type === 'tool_use');
    return tool ? { kind: 'tool', tool: tool.name } : { kind: 'reply' };
  }
  if (e.type !== 'user' || e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) return null;
  const c = e.message?.content;
  if (Array.isArray(c) && c.some(x => x?.type === 'tool_result')) return { kind: 'result' };
  const text = textOf(c);
  if (isStop(text)) return { kind: 'stop' };
  const command = text.match(/^<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/);
  if (command) return { kind: 'prompt', text: command[1].startsWith('/') ? command[1] : `/${command[1]}` };
  if (!text || /^<[a-z][\w-]*>/.test(text)) return null;
  return { kind: 'prompt', text };
}

/** Adds what an API call's line shows beyond what was counted for that call already. */
function count(s, e) {
  const u = e.type === 'assistant' && e.message?.usage;
  const id = e.message?.id;
  if (!u || !id) return false;
  const n = v => Number(v) || 0;
  const seen = [n(u.input_tokens) + n(u.cache_creation_input_tokens), n(u.output_tokens), n(u.cache_read_input_tokens)];
  const was = (s.calls ??= {})[id] ?? [0, 0, 0];
  const add = seen.map((v, i) => Math.max(0, v - was[i]));
  if (!add.some(Boolean)) return false;
  s.calls[id] = seen.map((v, i) => Math.max(v, was[i]));
  const t = (s.tokens ??= { input: 0, output: 0, cached: 0 });
  t.input += add[0];
  t.output += add[1];
  t.cached += add[2];
  if (!s.usedAt || e.timestamp > s.usedAt) s.usedAt = e.timestamp;
  return true;
}

function statusOf(s, now) {
  const age = (now - new Date(s.lastAt)) / 1000;
  if (age > IDLE_MIN * 60 || s.last === 'reply' || s.last === 'stop') return 'idle';
  if (s.last === 'tool') return age > WAITING_S ? 'waiting' : 'running';
  return 'running';
}

/** The complete lines in the next slice after `offset`, and the offset after the last of them. */
function readNew(file, offset, size, maxRead) {
  for (let len = Math.min(size - offset, maxRead); ; len = Math.min(size - offset, len * 2)) {
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    const end = buf.lastIndexOf(0x0a);
    if (end >= 0) return { lines: buf.subarray(0, end).toString('utf8').split('\n'), offset: offset + end + 1 };
    // One line longer than the slice: read further, unless it isn't finished being written.
    if (offset + len >= size) return { lines: [], offset };
  }
}

function noteFile(vault, s, project) {
  const id = s.id.slice(0, 8);
  const dir = path.join(vault, 'Sessions');
  const hit = fs.readdirSync(dir).find(f => f.endsWith(`-${id}.md`));
  return path.join(dir, hit ?? `${s.started.slice(0, 10)}-${project.slug}-${id}.md`);
}

function render(s, project, status) {
  const fields = {
    type: 'session', status, project: project.note ? `"[[${project.note}]]"` : q(project.slug), cwd: q(s.cwd), session_id: q(s.id),
    started: q(s.started), updated: q(s.lastAt), prompts: s.promptIds.length, last_prompt: q(s.previews.at(-1)?.text ?? ''),
    waiting_for: q(status === 'waiting' ? `permission for ${s.tool ?? 'a tool'}` : ''),
    tokens_in: s.tokens?.input ?? 0, tokens_out: s.tokens?.output ?? 0, tokens_cached: s.tokens?.cached ?? 0,
  };
  const lines = s.previews.map(p => `- ${p.ts.slice(11, 16)} ${p.text}`).join('\n');
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n# ${project.slug} · ${s.id.slice(0, 8)}\n\n## Prompts\n${lines}${lines ? '\n' : ''}`;
}

/** Applies new transcript lines to their sessions. Returns the prompts seen for the first time, for the activity log. */
function apply(sessions, lines, touched) {
  const added = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e?.sessionId || !e.timestamp) continue;
    const s = (sessions[e.sessionId] ??= { id: e.sessionId, promptIds: [], previews: [] });
    if (String(e.entrypoint ?? '').startsWith('sdk')) s.headless = true;
    if (s.headless) continue;
    if (count(s, e)) touched.add(s.id);
    if (e.isSidechain) continue;
    touched.add(s.id);
    if (!s.started || e.timestamp < s.started) Object.assign(s, { started: e.timestamp, cwd: e.cwd ?? s.cwd });
    s.cwd ??= e.cwd;
    const k = kindOf(e);
    if (!k) continue;
    if (!s.lastAt || e.timestamp >= s.lastAt) Object.assign(s, { last: k.kind, lastAt: e.timestamp, ...(k.tool ? { tool: k.tool } : {}) });
    const id = e.uuid ?? `${e.timestamp}:${k.text}`;
    if (k.kind !== 'prompt' || s.promptIds.includes(id)) continue;
    s.promptIds.push(id);
    s.previews = [...s.previews, { ts: e.timestamp, text: oneLine(k.text) }].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-MAX_PROMPTS);
    added.push({ ts: e.timestamp, text: k.text, id: s.id });
  }
  return added;
}

export const stateFileFor = home => path.join(home, '.productivity-os', 'sessions-sync.json');

/** The saved state, and its text as read ('' for a first sync, so that one is always saved). */
function loadState(file, now) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { state: { files: {}, sessions: {}, ...JSON.parse(text) }, saved: text.trim() };
  } catch { return { state: { files: {}, sessions: {}, since: now.toISOString(), agentsSince: now.toISOString() }, saved: '' }; }
}

/** A folder's transcripts and its sessions' sub-agent transcripts (<session>/subagents/*.jsonl); a folder that can't be listed is skipped. */
function transcriptsIn(dir) {
  const files = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.endsWith('.jsonl')) files.push({ file: path.join(dir, d.name) });
    const agents = path.join(dir, d.name, 'subagents');
    try {
      if (d.isDirectory() && fs.existsSync(agents)) files.push(...fs.readdirSync(agents).filter(n => n.endsWith('.jsonl')).map(n => ({ file: path.join(agents, n), agent: true })));
    } catch { /* not a folder, or gone meanwhile: try again next pass */ }
  }
  return files;
}

/** Reads what's new in every transcript into the state; a file that can't be read is skipped this pass. */
function readAll(root, state, now, maxRead) {
  const firstSight = now.valueOf() - FIRST_SYNC_DAYS * 864e5;
  const added = [];
  const touched = new Set();
  const present = new Set();
  for (const dir of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    for (const { file, agent } of transcriptsIn(path.join(root, dir.name))) {
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        present.add(file);
        const f = (state.files[file] ??= { offset: st.mtimeMs < firstSight || (agent && !state.agentsSince) ? st.size : 0 });
        if (st.size < f.offset) f.offset = 0;
        if (st.size === f.offset) continue;
        const { lines, offset } = readNew(file, f.offset, st.size, maxRead);
        f.offset = offset;
        added.push(...apply(state.sessions, lines, touched));
      } catch { /* deleted meanwhile, or unreadable: try again next pass */ }
    }
  }
  for (const file of Object.keys(state.files)) if (!present.has(file)) delete state.files[file];
  state.agentsSince ??= now.toISOString();
  return { added, touched };
}

/** One pass: read what's new and refresh the notes of sessions that changed or are still live. Returns the notes written. */
export function syncSessions(vault, { home = os.homedir(), now = new Date(), maxRead = MAX_READ } = {}) {
  const root = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(root) || !fs.existsSync(path.join(vault, 'Sessions'))) return [];
  const stateFile = stateFileFor(home);
  const { state, saved } = loadState(stateFile, now);
  const { added, touched } = readAll(root, state, now, maxRead);
  const written = [];
  for (const s of Object.values(state.sessions)) {
    if (!s.headless && (now - new Date(s.lastAt ?? s.usedAt)) / 864e5 > FORGET_DAYS) { delete state.sessions[s.id]; continue; }
    if (s.headless || !s.lastAt) continue;
    const status = statusOf(s, now);
    if (!touched.has(s.id) && s.status === status) continue;
    const project = projectFor(s.cwd, vault);
    const target = noteFile(vault, s, project);
    const text = render(s, project, status);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) { writeFileAtomic(target, text); written.push(path.basename(target)); }
    s.status = status;
  }
  // State first (atomically): if appending the log then fails, a prompt is missed, never logged twice.
  if (JSON.stringify(state) !== saved) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileAtomic(stateFile, JSON.stringify(state) + '\n');
  }
  // Prompts from before the first sync were logged by the old hook already.
  const logged = added.filter(a => a.ts >= state.since && state.sessions[a.id] && !state.sessions[a.id].headless);
  if (logged.length) {
    fs.mkdirSync(path.join(vault, '_system'), { recursive: true });
    fs.appendFileSync(path.join(vault, '_system', 'activity.jsonl'), logged.map(a => {
      const s = state.sessions[a.id];
      return JSON.stringify({ ts: a.ts, event: 'UserPromptSubmit', session_id: s.id, project: projectFor(s.cwd, vault).slug, cwd: s.cwd, prompt: a.text }) + '\n';
    }).join(''));
  }
  return written;
}
