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
  ["verify: untested stories pass", "tools/forge/verify.mjs", "if (!checked.has(n)) findings.push(", "if (false) findings.push("],
  ["verify: a missing report is ignored", "tools/forge/verify.mjs", "if (parsed.error) { findings.push(", "if (parsed.error) { continue; findings.push("],
  ["verify: never asks when not converging", "tools/forge/verify.mjs", "if (last !== undefined && actionable.length >= last)", "if (false)"],
  ["verify: unbounded rounds", "tools/forge/verify.mjs", "if (v.round >= v.limit)", "if (false)"],
  ["verify: reviewers may write", "tools/forge/verify.mjs", "{ id: 'architecture', label: 'architecture review', prompt: 'verify-architecture', tools: 'Read,Glob,Grep' }", "{ id: 'architecture', label: 'architecture review', prompt: 'verify-architecture', tools: WORKER_TOOLS }"],
  ["verify: low findings ticketed", "tools/forge/verify.mjs", "const actionable = findings.filter(x => x.severity !== 'low');", "const actionable = findings;"],
  ["verify: duplicate tickets", "tools/forge/verify.mjs", "const issue = open.get(title) ?? issueNumberOf(", "const issue = issueNumberOf("],
  ["verify: failing check can pass", "tools/forge/verify.mjs", "for (const c of reports.qa.checks.filter(x => !x.ok)) findings.push(", "for (const c of reports.qa.checks.filter(() => false)) findings.push("],
  ["verify: untagged story counts as tested", "tools/forge/verify.mjs", "else if (!tagged.has(n))", "else if (false)"],
  ["verify: unreadable stories pass", "tools/forge/verify.mjs", "if (!stories.length) findings.push(", "if (false) findings.push("],
  ["verify: reviewers share a checkout", "tools/forge/verify.mjs", "`review-${round}-${r.id}`", "`review-${round}`"],
  ["verify: reused ticket keeps its old PR", "tools/forge/verify.mjs", "pr: null, sha: null, merge_sha: null, run: null, blocked: null", "run: null"],
  ["verify: reviewer text unquoted", "tools/forge/verify.mjs", "${quoted(x.details || x.title)}", "${x.details || x.title}"],
  ["verify: E2E tests never merged", "tools/forge/verify.mjs", "return queueTestPr(b, ctx) ? startFixing(f, b, ctx, []) : verified(vault, f, b, ctx, low);", "return verified(vault, f, b, ctx, low);"],
  ["verify: usage stop filed as a bug", "tools/forge/verify.mjs", "if (s !== 'timeout' && s.usageLimit) {", "if (false) {"],
  ["demo: production deploy", "tools/forge/demo.mjs", "const PREVIEW = [...WRANGLER, 'preview', '--name', 'demo'];", "const PREVIEW = [...WRANGLER, 'deploy'];"],
  ["demo: wrangler fetched from npm", "tools/forge/demo.mjs", "const WRANGLER = ['--no-install', 'wrangler'];", "const WRANGLER = ['wrangler'];"],
  ["demo: preview inside the executor pass", "tools/forge/demo.mjs", "      if (!r) return log;\n      Object.assign(d, { preview: r", "      if (false) return log;\n      Object.assign(d, { preview: r"],
  ["demo: tour keeps your Cloudflare token", "tools/forge/workers.mjs", "const SECRETS = ['CLOUDFLARE_API_TOKEN',", "const SECRETS = ['"],
  ["demo: tour finds stored logins", "tools/forge/workers.mjs", "XDG_CONFIG_HOME: path.join(dir, 'config'),", ""],
  ["demo: tour writes anywhere", "tools/forge/demo.mjs", "Write(forge-demo/**),Edit(forge-demo/**)", "Write,Edit"],
  ["demo: symlinked shot copied", "tools/forge/demo.mjs", "const real = fs.realpathSync(src);", "const real = src;"],
  ["demo: any file passes as a PNG", "tools/forge/demo.mjs", "return head.equals(PNG);", "return true;"],
  ["demo: checkout from a pushed branch", "tools/forge/demo.mjs", "prepareWorktree(ctx.sys, b.clone, 'demo', 0, { fromMain: true })", "prepareWorktree(ctx.sys, b.clone, 'demo', 0)"],
  ["demo: crash costs a second tour", "tools/forge/demo.mjs", "    if (!d.result && !d.run) {", "    if (!d.run) { d.result = null;"],
  ["cost: worker runs not counted", "tools/forge/build.mjs", "    addSpend(b, s);\n    if (s === 'timeout') { ctx.sys.kill(t.run.pid);", "    if (s === 'timeout') { ctx.sys.kill(t.run.pid);"],
  ["cost: lead runs not counted", "tools/forge/build.mjs", "  addSpend(b, s);\n  if (s === 'timeout') ctx.sys.kill(t.leadRun.pid);", "  if (s === 'timeout') ctx.sys.kill(t.leadRun.pid);"],
  ["demo: deploys without asking", "tools/forge/verify.mjs", "save(f, { stage: 'verified', status: 'waiting', review_key: key }", "save(f, { stage: 'demo', status: 'running', review_key: key }"],
  ["demo: No still deploys", "tools/forge/forge.mjs", "if (status === 'done') { save(f, { stage: 'demo'", "if (true) { save(f, { stage: 'demo'"],
  ["demo: tour may run any npx", "tools/forge/demo.mjs", "Bash(npx playwright:*)';", "Bash(npx playwright:*),Bash(npx:*)';"],
  ["demo: too-old wrangler used", "tools/forge/demo.mjs", "if (older([", "if (false && older(["],
  ["demo: failed preview fails the demo", "tools/forge/demo.mjs", "} catch (e) { return { reason: `wrangler preview failed", "} catch (e) { throw e; return { reason: `wrangler preview failed"],
  ["demo: shots from outside the checkout copied", "tools/forge/demo.mjs", "if (!real.startsWith(root + path.sep) || ", "if ("],
  ["demo: unshot story not a gap", "tools/forge/demo.mjs", "...all.filter(s => !shots[s.n])", "...all.filter(() => false)"],
  ["demo: usage stop ends the demo", "tools/forge/demo.mjs", "      if (s.usageLimit) {\n        d.retryAfter", "      if (false) {\n        d.retryAfter"],
  ["demo: accepted findings not listed", "tools/forge/demo.mjs", "...(b.verify?.accepted ?? []).map(", "...[].map("],
  ["cost: verify runs not counted", "tools/forge/verify.mjs", "    addSpend(b, s);\n    if (s === 'timeout') ctx.sys.kill(run.pid);", "    if (s === 'timeout') ctx.sys.kill(run.pid);"],
  ["sessions: headless runs get notes", "tools/sessions/transcripts.mjs", "if (s.headless) continue;\n    touched.add(s.id);", "touched.add(s.id);"],
  ["sessions: sub-agents get notes", "tools/sessions/transcripts.mjs", "if (!e?.sessionId || e.isSidechain || !e.timestamp) continue;", "if (!e?.sessionId || !e.timestamp) continue;"],
  ["sessions: transcripts re-read from the start", "tools/sessions/transcripts.mjs", "readNew(file, f.offset, st.size, maxRead)", "readNew(file, 0, st.size, maxRead)"],
  ["sessions: a tool result is not activity", "tools/sessions/transcripts.mjs", "if (Array.isArray(c) && c.some(x => x?.type === 'tool_result')) return { kind: 'result' };", ""],
  ["sessions: old history imported", "tools/sessions/transcripts.mjs", "offset: st.mtimeMs < firstSight ? st.size : 0", "offset: 0"],
  ["sessions: copied entries counted twice", "tools/sessions/transcripts.mjs", "if (k.kind !== 'prompt' || s.promptIds.includes(id)) continue;", "if (k.kind !== 'prompt') continue;"],
  ["sessions: compaction summary as a prompt", "tools/sessions/transcripts.mjs", "e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly", "e.isMeta"],
  ["sessions: interrupt reads as running", "tools/sessions/transcripts.mjs", "s.last === 'reply' || s.last === 'stop'", "s.last === 'reply'"],
  ["sessions: state in the vault", "tools/sessions/transcripts.mjs", "path.join(home, '.productivity-os', 'sessions-sync.json')", "path.join(home, '..', 'Vault', '_system', 'sessions-sync.json')"],
  ["sessions: old prompts re-logged", "tools/sessions/transcripts.mjs", "added.filter(a => a.ts >= state.since && ", "added.filter(a => "],
  ["sessions: one bad file stops the pass", "tools/sessions/transcripts.mjs", "} catch { /* deleted meanwhile", "} finally { /* deleted meanwhile"],
  ["sessions: old hook left in place", "tools/hooks/install.mjs", ": withStatusLine(withoutHook(current));", ": withStatusLine(current);"],
  ["sessions: executor never syncs", "tools/actions/executor.mjs", "try { syncSessions(vault); }", "try { void syncSessions; }"],
  ["sell: drafter gets the web", "tools/forge/sell.mjs", "const PACK_TOOLS = 'Read(./**),Glob,Grep,Write(forge-pack/**),Edit(forge-pack/**)';", "const PACK_TOOLS = 'Read(./**),Glob,Grep,Write(forge-pack/**),Edit(forge-pack/**),WebFetch';"],
  ["sell: drafter reads your clone", "tools/forge/sell.mjs", "const PACK_TOOLS = 'Read(./**),", "const PACK_TOOLS = 'Read,"],
  ["sell: .env read from the worktree only", "tools/forge/sell.mjs", "[...new Set([b.clone, wt].filter(Boolean))]", "[wt]"],
  ["sell: shorter value redacted first", "tools/forge/sell.mjs", ".sort((a, c) => c.length - a.length)", ".sort((a, c) => a.length - c.length)"],
  ["sell: exported values missed", "tools/forge/sell.mjs", "/^\\s*(?:export\\s+)?([A-Za-z_]\\w*)", "/^\\s*([A-Za-z_]\\w*)"],
  ["sell: linked forge-pack read", "tools/forge/sell.mjs", "if (!root.startsWith(fs.realpathSync(wt) + path.sep)) return null;", ""],
  ["sell: Worker secrets missed", "tools/forge/sell.mjs", "/\\benv\\.([A-Z_][A-Z0-9_]*)\\b/g];", "];"],
  ["sell: errors retried forever", "tools/forge/sell.mjs", "if (p.errors >= MAX_ERRORS)", "if (false)"],
  ["sell: known issues unredacted", "tools/forge/sell.mjs", "'known-issues': redact(", "'known-issues': ((t) => ({ text: t }))("],
  ["sell: drafter keeps your credentials", "tools/forge/sell.mjs", "const env = sandboxEnv(path.join(ctx.logDir, 'sell-sandbox'));", "const env = undefined;"],
  ["sell: No still drafts", "tools/forge/forge.mjs", "if (status === 'done') { save(f, { stage: 'sell'", "if (true) { save(f, { stage: 'sell'"],
  ["sell: dependencies' env counted", "tools/forge/sell.mjs", "new Set(['node_modules', ", "new Set(["],
  ["sell: dev dependencies audited", "tools/forge/sell.mjs", "filter(([k, v]) => k && !v.dev)", "filter(([k]) => k)"],
  ["sell: MIT OR GPL flagged", "tools/forge/sell.mjs", "split(/\\s+OR\\s+/i).some(alt =>", "split(/\\s+OR\\s+/i).every(alt =>"],
  ["sell: .env values not redacted", "tools/forge/sell.mjs", "for (const v of values) {", "for (const v of []) {"],
  ["sell: secret shapes not redacted", "tools/forge/sell.mjs", "for (const re of SECRET_SHAPES)", "for (const re of [])"],
  ["sell: symlinked draft copied", "tools/forge/sell.mjs", "const real = insideFile(path.join(root, `${name}.md`), root);", "const real = path.join(root, `${name}.md`);"],
  ["sell: drafts not marked", "tools/forge/sell.mjs", "fs.writeFileSync(path.join(out, to), DRAFT_MARK + r.text);", "fs.writeFileSync(path.join(out, to), r.text);"],
  ["sell: usage stop ends the pack", "tools/forge/sell.mjs", "      if (s.usageLimit) {\n        p.retryAfter", "      if (false) {\n        p.retryAfter"],
  ["sell: missing draft not retried", "tools/forge/sell.mjs", "if (missing.length && ++p.attempts < MAX_ATTEMPTS)", "if (false)"],
  ["sell: demo gaps not known issues", "tools/forge/sell.mjs", "...(b.demo?.gaps ?? []).map(", "...[].map("],
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
