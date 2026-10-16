// Stage outputs a well-behaved `claude -p` would write, for the forge tests.
import fs from 'node:fs';
import path from 'node:path';

export const SPEC = `# Spec\n## Problem\nx\n## Users\nx\n## User stories\n1. As a user, I want a thing.\nAcceptance criteria:\n- [ ] works\n## Non-goals\nx\n## Data model\nx\n## Open questions\nNone.\n`;
export const ADR = `# 0001 Stack\n## Context\nx\n## Options\nx\n## Decision\nAstro + Cloudflare + Supabase.\n## Consequences\nx\n`;
const NAMES = ['Tidewell', 'Quillo', 'Brightjar', 'Nookly', 'Fernway', 'Lumen Lane', 'Parcelo', 'Driftkit', 'Hearthly', 'Mosswise', 'Plinth'];
export const NAMING = `# Naming\n## Candidates\n| Name | Rationale |\n|---|---|\n${NAMES.map(n => `| ${n} | short |`).join('\n')}\n## Pick\nTidewell.\n`;
export const PLAN = `# Plan
## Milestones
1. Scaffold. 2. Core.
## Tickets
### T1: Scaffold the repo
Depends on: none
Intent: As the owner, I want a repo with the gate green.
Acceptance criteria:
- [ ] gate green
Scope boundaries:
- no features
Pointers:
- ADR 0001

### T3: Share a list
Depends on: T2
Intent: As a user, I want to share.
Acceptance criteria:
- [ ] link works
Scope boundaries:
- no auth changes
Pointers:
- spec story 2

### T2: Make a list
**Depends on:** T1
**Intent:** As a user, I want a list.
**Acceptance criteria:**
- [ ] list saves
**Scope boundaries:**
- none
**Pointers:**
- spec story 1
`;

const OUTPUTS = [
  [/interview mode/, 'questions.md', '1. Who pays?\nAnswer: teams\n'],
  [/spec stage/, 'spec.md', SPEC],
  [/stack stage/, 'decisions/0001-stack.md', ADR],
  [/naming stage/, 'naming.md', NAMING],
  [/plan stage/, 'plan.md', PLAN],
];

/** A fake runClaude: writes the matching stage file (or `override` for it) and records the prompt. */
export function fakeClaude(calls, override = {}) {
  return (prompt, cwd) => {
    calls.push({ prompt, cwd });
    const [, file, text] = OUTPUTS.find(([re]) => re.test(prompt));
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), override[file] ?? text);
    return { ok: true, text: 'done' };
  };
}

/** gh stand-in: a repo exists once created; issues get increasing numbers; `failOn` makes one issue title fail once. */
export function fakeGh(calls, { failOn } = {}) {
  let n = 0;
  let created = false;
  let failed = false;
  return (args, input) => {
    calls.push({ args, input });
    const notFound = () => { throw Object.assign(new Error('HTTP 404'), { stderr: 'Not Found (HTTP 404)' }); };
    if (args[0] === 'repo' && args[1] === 'view') return created ? 'tidewell' : notFound();
    if (args[0] === 'repo' && args[1] === 'create') { created = true; return ''; }
    if (args[0] === 'api' && !args.includes('PUT')) return notFound();
    if (args[0] === 'issue') {
      if (failOn && !failed && args.includes(failOn)) { failed = true; throw new Error('HTTP 502'); }
      return `https://github.com/me/tidewell/issues/${++n}\n`;
    }
    return '';
  };
}

export const fetch404 = async () => ({ status: 404 });
