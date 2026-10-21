// Session notes from Claude Code's own transcripts (~/.claude/projects/<cwd>/<session>.jsonl),
// read by the executor each pass: no hook runs inside any Claude session. Each file is read on
// from where the last pass stopped (a half-written line waits), headless runs (`claude -p`, the
// forge's workers) and sub-agents are skipped, and new prompts also go whole into the local
// _system/activity.jsonl for /suggest. State lives in _system/sessions-sync.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFor } from '../vault/projects.mjs';

const STATE = path.join('_system', 'sessions-sync.json');
const FIRST_SYNC_DAYS = 14;
const IDLE_MIN = 30;
const WAITING_S = 60;
const PREVIEW = 160;
const MAX_PROMPTS = 50;

const oneLine = (s, n = PREVIEW) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const q = s => JSON.stringify(s ?? '');

/** Your prompt in a user entry, or null for meta and system text. "/name" for a slash command. */
function promptOf(e) {
  if (e.isMeta) return null;
  const c = e.message?.content;
  const text = (Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join('\n') : String(c ?? '')).trim();
  const command = text.match(/^<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/);
  if (command) return command[1].startsWith('/') ? command[1] : `/${command[1]}`;
  // Text Claude Code or the harness adds in your name: system tags, interruption markers.
  if (!text || /^<[a-z][\w-]*>/.test(text) || text.startsWith('[Request interrupted')) return null;
  return text;
}

/** What an entry tells us: a prompt, a tool call (with its name), a tool result, a reply; or nothing. */
function kindOf(e) {
  if (e.type === 'user') {
    const c = e.message?.content;
    if (Array.isArray(c) && c.some(x => x?.type === 'tool_result')) return { kind: 'result' };
    const text = promptOf(e);
    return text ? { kind: 'prompt', text } : null;
  }
  if (e.type === 'assistant') {
    const tool = (e.message?.content ?? []).find?.(x => x?.type === 'tool_use');
    return tool ? { kind: 'tool', tool: tool.name } : { kind: 'reply' };
  }
  return null;
}

function statusOf(s, now) {
  const age = (now - new Date(s.lastAt)) / 1000;
  if (age > IDLE_MIN * 60 || s.last === 'reply') return 'idle';
  if (s.last === 'tool') return age > WAITING_S ? 'waiting' : 'running';
  return 'running';
}

/** The complete lines added since `offset`, and the offset after the last of them. */
function readNew(file, offset, size) {
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { lines: [], offset };
  return { lines: buf.subarray(0, end).toString('utf8').split('\n'), offset: offset + end + 1 };
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
    started: q(s.started), updated: q(s.lastAt), prompts: s.prompts, last_prompt: q(s.lastPrompt), waiting_for: q(status === 'waiting' ? `permission for ${s.tool ?? 'a tool'}` : ''),
  };
  const lines = s.previews.map(p => `- ${p.ts.slice(11, 16)} ${p.text}`).join('\n');
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n# ${project.slug} · ${s.id.slice(0, 8)}\n\n## Prompts\n${lines}${lines ? '\n' : ''}`;
}

/**
 * Applies a transcript's new entries to their sessions (one session can span files, when it was
 * resumed from another folder). Returns the prompts added, for the activity log.
 */
function apply(sessions, lines, touched) {
  const added = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e?.sessionId || e.isSidechain || !e.timestamp) continue;
    const s = (sessions[e.sessionId] ??= { id: e.sessionId, prompts: 0, previews: [] });
    touched.add(s.id);
    if (String(e.entrypoint ?? '').startsWith('sdk')) s.headless = true;
    if (!s.started || e.timestamp < s.started) s.started = e.timestamp;
    const k = kindOf(e);
    if (!k) continue;
    if (!s.lastAt || e.timestamp >= s.lastAt) Object.assign(s, { last: k.kind, lastAt: e.timestamp, cwd: e.cwd ?? s.cwd, ...(k.tool ? { tool: k.tool } : {}) });
    if (k.kind !== 'prompt') continue;
    s.prompts += 1;
    s.previews = [...s.previews, { ts: e.timestamp, text: oneLine(k.text) }].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-MAX_PROMPTS);
    s.lastPrompt = s.previews.at(-1).text;
    added.push({ ts: e.timestamp, text: k.text, id: s.id });
  }
  return added;
}

function loadState(vault) {
  try { return { files: {}, sessions: {}, ...JSON.parse(fs.readFileSync(path.join(vault, STATE), 'utf8')) }; } catch { return { files: {}, sessions: {} }; }
}

/** One pass: read what's new in every transcript and refresh the notes of sessions that changed or are still live. */
export function syncSessions(vault, { home = os.homedir(), now = new Date() } = {}) {
  const root = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(root) || !fs.existsSync(path.join(vault, 'Sessions'))) return [];
  const state = loadState(vault);
  const firstSight = now.valueOf() - FIRST_SYNC_DAYS * 864e5;
  const added = [];
  const touched = new Set();
  for (const dir of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    for (const name of fs.readdirSync(path.join(root, dir.name)).filter(n => n.endsWith('.jsonl'))) {
      const file = path.join(root, dir.name, name);
      const st = fs.statSync(file);
      const f = (state.files[file] ??= { offset: st.mtimeMs < firstSight ? st.size : 0 });
      if (st.size < f.offset) f.offset = 0;
      if (st.size === f.offset) continue;
      const { lines, offset } = readNew(file, f.offset, st.size);
      f.offset = offset;
      added.push(...apply(state.sessions, lines, touched));
    }
  }
  const written = [];
  for (const s of Object.values(state.sessions)) {
    if (s.headless || !s.lastAt) continue;
    const status = statusOf(s, now);
    if (!touched.has(s.id) && s.status === status) continue;
    const project = projectFor(s.cwd, vault);
    const target = noteFile(vault, s, project);
    const text = render(s, project, status);
    const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (old !== text) { fs.writeFileSync(target, text); written.push(path.basename(target)); }
    s.status = status;
  }
  fs.mkdirSync(path.join(vault, '_system'), { recursive: true });
  const logged = added.filter(a => !state.sessions[a.id].headless);
  if (logged.length) {
    fs.appendFileSync(path.join(vault, '_system', 'activity.jsonl'), logged.map(a => {
      const s = state.sessions[a.id];
      return JSON.stringify({ ts: a.ts, event: 'UserPromptSubmit', session_id: s.id, project: projectFor(s.cwd, vault).slug, cwd: s.cwd, prompt: a.text }) + '\n';
    }).join(''));
  }
  fs.writeFileSync(path.join(vault, STATE), JSON.stringify(state) + '\n');
  return written;
}
