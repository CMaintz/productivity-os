// The Forge's stages: what each one writes and the sections that file must have before the
// forge moves on. Also parses plan.md's tickets, which become GitHub issues.

export const STAGES = [
  { id: 'spec', output: 'spec.md', sections: ['Problem', 'Users', 'User stories', 'Non-goals', 'Data model', 'Open questions'] },
  { id: 'stack', output: 'decisions/0001-stack.md', sections: ['Context', 'Options', 'Decision', 'Consequences'] },
  { id: 'naming', output: 'naming.md', sections: ['Candidates'] },
  { id: 'plan', output: 'plan.md', sections: ['Milestones', 'Tickets'] },
];
export const STAGE_IDS = STAGES.map(s => s.id);
export const stageById = id => STAGES.find(s => s.id === id);
export const nextStage = id => STAGE_IDS[STAGE_IDS.indexOf(id) + 1] ?? null;

const headings = text => [...String(text).matchAll(/^#{2,3} +(.+?)\s*$/gm)].map(m => m[1].toLowerCase());

/** Problems with a stage's output; an empty list means it can move on. */
export function checkOutput(stage, text) {
  if (!text || !text.trim()) return [`${stage.output} is missing or empty`];
  const have = headings(text);
  const problems = stage.sections.filter(s => !have.some(h => h.startsWith(s.toLowerCase()))).map(s => `${stage.output} has no "${s}" section`);
  if (stage.id === 'spec' && !/acceptance criteria/i.test(text)) problems.push('spec.md: user stories need acceptance criteria');
  if (stage.id === 'naming' && candidates(text).length < 10) problems.push('naming.md needs at least 10 candidates in its table');
  if (stage.id === 'plan') problems.push(...parsePlan(text).problems);
  return problems;
}

/** Names from naming.md's candidates table: the first column after the header, in rank order. */
export function candidates(text) {
  const section = String(text).split(/^## +Candidates.*$/m)[1]?.split(/^## /m)[0] ?? '';
  return section.split('\n').filter(l => /^\|/.test(l.trim()))
    .map(l => l.split('|').map(c => c.trim())[1] ?? '')
    .filter((c, i) => i > 1 && c && !/^-+$/.test(c))
    .map(c => c.replace(/[*`]/g, ''));
}

const TICKET = /^### +T(\d+): *(.+)$/gm;
const FIELDS = ['Depends on', 'Intent', 'Acceptance criteria', 'Scope boundaries', 'Pointers'];

function ticketFields(body) {
  const out = {};
  for (const f of FIELDS) {
    const m = body.match(new RegExp(`^\\*{0,2}${f}:?\\*{0,2}:? *(.*)$`, 'mi'));
    if (!m) continue;
    const rest = body.slice(m.index + m[0].length);
    const next = FIELDS.map(g => rest.search(new RegExp(`^\\*{0,2}${g}:?\\*{0,2}:?`, 'mi'))).filter(i => i >= 0);
    out[f] = `${m[1]}\n${rest.slice(0, next.length ? Math.min(...next) : undefined)}`.trim();
  }
  return out;
}

/** plan.md's tickets: `### T<n>: title` blocks with the Foundry fields. */
export function parsePlan(text) {
  const src = String(text);
  const heads = [...src.matchAll(TICKET)];
  const problems = heads.length ? [] : ['plan.md has no "### T<n>: <title>" tickets'];
  const tickets = heads.map((m, i) => {
    const body = src.slice(m.index + m[0].length, heads[i + 1]?.index ?? src.length).split(/^## /m)[0];
    const f = ticketFields(body);
    const dependsOn = [...(f['Depends on'] ?? '').matchAll(/T(\d+)/g)].map(d => Number(d[1]));
    for (const k of FIELDS.slice(1)) if (!f[k]) problems.push(`T${m[1]} has no ${k}`);
    return { n: Number(m[1]), title: m[2].trim(), dependsOn, intent: f.Intent ?? '', criteria: f['Acceptance criteria'] ?? '', scope: f['Scope boundaries'] ?? '', pointers: f.Pointers ?? '' };
  });
  const ids = new Set(tickets.map(t => t.n));
  for (const t of tickets) for (const d of t.dependsOn) if (!ids.has(d)) problems.push(`T${t.n} depends on missing T${d}`);
  if (!problems.length && !topoOrder(tickets)) problems.push('ticket dependencies form a cycle');
  return { tickets, problems };
}

/** Tickets ordered so each comes after what it depends on; null on a cycle. */
export function topoOrder(tickets) {
  const done = new Set();
  const out = [];
  while (out.length < tickets.length) {
    const ready = tickets.filter(t => !done.has(t.n) && t.dependsOn.every(d => done.has(d)));
    if (!ready.length) return null;
    for (const t of ready) { done.add(t.n); out.push(t); }
  }
  return out;
}
