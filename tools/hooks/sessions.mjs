// Turns Claude Code hook events into a session note per session in the vault's
// Sessions/ folder, plus one line per event in _system/activity.jsonl (local only).
// Pure functions here; session-hook.mjs does the I/O.

import path from 'node:path';

const PROMPT_PREVIEW = 160;
const MAX_PROMPT_LINES = 50;

// Hook event -> what the session is doing now.
const STATUS = {
  SessionStart: 'idle',      // open, waiting for the first prompt
  UserPromptSubmit: 'running',
  Notification: 'waiting',   // needs permission or input
  Stop: 'idle',              // finished its turn, ball is with the user
  SessionEnd: 'ended',
};

export const statusFor = event => STATUS[event] ?? null;

const oneLine = (s, n = PROMPT_PREVIEW) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const q = s => JSON.stringify(s ?? '');
const hhmm = iso => iso.slice(11, 16);

export function sessionFile(vault, input, project, now) {
  const id = String(input.session_id || 'unknown').slice(0, 8);
  return path.join(vault, 'Sessions', `${now.slice(0, 10)}-${project.slug}-${id}.md`);
}

/** Frontmatter fields for a session note; `prev` holds the fields from the existing note. */
export function sessionFields(input, project, now, prev = {}) {
  const event = input.hook_event_name;
  const prompts = Number(prev.prompts || 0) + (event === 'UserPromptSubmit' ? 1 : 0);
  return {
    type: 'session',
    status: statusFor(event) ?? prev.status ?? 'idle',
    project: project.note ? `"[[${project.note}]]"` : q(project.slug),
    cwd: q(input.cwd),
    session_id: q(input.session_id),
    started: prev.started ?? q(now),
    updated: q(now),
    prompts,
    last_prompt: event === 'UserPromptSubmit' ? q(oneLine(input.prompt)) : (prev.last_prompt ?? '""'),
    waiting_for: event === 'Notification' ? q(oneLine(input.message)) : '""',
  };
}

export function renderFrontmatter(fields) {
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
}

/** Reads `key: value` pairs back from a note we wrote (values kept as raw YAML). */
export function readFrontmatter(note) {
  const m = note?.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fields: {}, body: note ?? '' };
  const fields = Object.fromEntries(m[1].split(/\r?\n/).map(l => l.match(/^(\w+):\s?(.*)$/)).filter(Boolean).map(x => [x[1], x[2]]));
  return { fields, body: note.slice(m[0].length) };
}

/** Body: a title and a capped list of prompt previews, newest last. */
export function sessionBody(prevBody, input, project, now) {
  const title = `# ${project.slug} · ${String(input.session_id || '').slice(0, 8)}\n\n## Prompts\n`;
  const lines = (prevBody.match(/^- \d\d:\d\d .*$/gm) ?? []);
  if (input.hook_event_name === 'UserPromptSubmit') lines.push(`- ${hhmm(now)} ${oneLine(input.prompt)}`);
  return title + lines.slice(-MAX_PROMPT_LINES).join('\n') + '\n';
}

export function updateNote(existing, input, project, now) {
  const { fields, body } = readFrontmatter(existing);
  return renderFrontmatter(sessionFields(input, project, now, fields)) + sessionBody(body, input, project, now);
}

/** One JSON line per event. Full prompt text stays here, on this PC only. */
export function activityLine(input, project, now) {
  const { hook_event_name: event, session_id, cwd } = input;
  const extra = event === 'UserPromptSubmit' ? { prompt: input.prompt } : event === 'Notification' ? { message: input.message } : {};
  return JSON.stringify({ ts: now, event, session_id, project: project.slug, cwd, ...extra }) + '\n';
}
