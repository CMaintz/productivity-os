#!/usr/bin/env node
// Test quality check: breaks one important behaviour at a time and runs the tests. Every break
// must turn the suite red; a survivor means a behaviour we rely on has no test that protects it.
// Add a line here when you add a behaviour that matters (a guardrail, a privacy line, a safety
// check). Slow (one full test run per line), so it's not in the gate: npm run mutants.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// [what breaks, file, original code, broken code]
const MUTANTS = [
  ["guard: no widening check", "tools/widgets/guard.mjs", "if (added.length) problems.push", "if (false) problems.push"],
  ["guard: generated files unchecked", "tools/widgets/guard.mjs", "if (readHead(file) !== want.get(file))", "if (false)"],
  ["manifest: private fields allowed", "tools/widgets/manifest.mjs", "if (PRIVATE_FIELDS.includes(k)) errors.push", "if (false) errors.push"],
  ["snapshot: card results leak", "tools/dashboard/snapshot.mjs", "result: lastOutcome(c.text)", "result: c.text"],
  ["sync: press applies to any card", "tools/dashboard/sync.mjs", "if (!ALLOWED_FROM[e.status]?.includes(card.status)) return", "if (false) return"],
  ["policy: max not enforced", "tools/actions/policy.mjs", "&& rank(target) <= rank(row.max)", ""],
  ["cards: same-day card silently dropped", "tools/actions/cards.mjs", "for (let i = 2; fs.existsSync(file); i++) file = `${base}-${i}.md`;", "if (fs.existsSync(file)) return null;"],
  ["forge: your stop overwritten", "tools/forge/state.mjs", "const stoppedByYou = current.status === 'stopped' && f.status !== 'stopped';", "const stoppedByYou = false;"],
  ["forge: model gets web in spec", "tools/forge/forge.mjs", "spec: FILE_TOOLS,", "spec: `${FILE_TOOLS},WebFetch`,"],
  ["build: merge ignores GitHub verdict", "tools/forge/build.mjs", "allGreen(checks) && view.mergeStateStatus === 'CLEAN'", "true"],
  ["build: red PR not counted", "tools/forge/build.mjs", "if (m.red) { fail(", "if (false) { fail("],
  ["build: usage limit ignored", "tools/forge/build.mjs", "if (pct < limit) return false;", "return false;"],
  ["build: merged PR without Closes stuck", "tools/forge/build.mjs", "|| pr?.state === 'MERGED'", ""],
  ["lead: may write", "tools/forge/lead.mjs", "const LEAD_TOOLS = 'Read,Glob,Grep,", "const LEAD_TOOLS = 'Read,Write,Glob,Grep,"],
  ["workers: may merge", "tools/forge/workers.mjs", "const GH = ['issue view',", "const GH = ['pr merge', 'issue view',"],
  ["naming: failed lookup reads free", "tools/forge/naming.mjs", "const byStatus = s => (s === 404 ? 'free' : s === 200 ? 'taken' : '?');", "const byStatus = s => (s === 200 ? 'taken' : 'free');"],
  ["repo: duplicate issues on retry", "tools/forge/repo.mjs", ".filter(x => !issueOf[x.n])", ""],
  ["usage: dropped window reads 0", "tools/hooks/statusline.mjs", "const pct = v => (Number.isFinite(v) ? v : null);", "const pct = v => (Number.isFinite(v) ? v : 0);"],
  ["usage: stale record trusted", "tools/forge/build.mjs", "(now - new Date(u.recordedAt)) / 6e4 <= STALE_MIN", "true"],
  ["code widgets: off-switch never trips", "tools/widgets/code-widgets.mjs", "if (mine.length < ERROR_LIMIT) return w;", "return w;"],
];

const survivors = [];
for (const [name, file, original, broken] of MUTANTS) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(original)) { console.log(`??       ${name}: the original code moved; update this line`); survivors.push(name); continue; }
  fs.writeFileSync(file, src.replace(original, broken));
  try {
    const r = spawnSync(process.execPath, ['--test', 'tools/**/test/*.test.mjs'], { encoding: 'utf8' });
    const caught = r.status !== 0;
    console.log(`${caught ? 'caught  ' : 'SURVIVED'} ${name}`);
    if (!caught) survivors.push(name);
  } finally { fs.writeFileSync(file, src); }
}
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} caught`);
process.exit(survivors.length ? 1 : 0);
