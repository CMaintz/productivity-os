// An in-memory GitHub (issues, labels, PRs, checks), a process system and a forge already in
// its build stage, for the build and verify tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { advanceForges, listForges, newForge } from '../forge.mjs';
import { loadBuild } from '../build.mjs';
import { listCards } from '../../actions/cards.mjs';
import { PLAN } from './fixtures.mjs';

export function fakeGitHub(issueNumbers) {
  const gh = { issues: new Map(issueNumbers.map(n => [n, { number: n, title: `T${n}`, state: 'OPEN', labels: new Set() }])), prs: [], checks: {}, calls: [], next: 100 };
  gh.run = (args, input) => {
    gh.calls.push({ args, input });
    const [a, b] = args;
    const num = Number(args[2]);
    if (a === 'repo' && b === 'clone') { fs.mkdirSync(args[3], { recursive: true }); return ''; }
    if (a === 'issue' && b === 'list') return JSON.stringify([...gh.issues.values()].map(i => ({ number: i.number, title: i.title, state: i.state, labels: [...i.labels].map(name => ({ name })) })));
    if (a === 'pr' && b === 'list') return JSON.stringify(gh.prs);
    if (a === 'pr' && b === 'checks') {
      const checks = JSON.stringify(gh.checks[num] ?? []);
      if ((gh.checks[num] ?? []).some(c => c.bucket !== 'pass' && c.bucket !== 'skipping')) throw Object.assign(new Error('exit 1'), { stdout: checks });
      return checks;
    }
    if (a === 'pr' && b === 'view') { const p = gh.prs.find(x => x.number === num); return JSON.stringify({ mergeStateStatus: p.mergeState ?? 'CLEAN', headRefOid: p.headRefOid }); }
    if (a === 'pr' && b === 'merge') { const p = gh.prs.find(x => x.number === num); p.state = 'MERGED'; return ''; }
    if (a === 'issue' && b === 'edit') {
      const i = gh.issues.get(num);
      args.forEach((x, k) => { if (x === '--add-label') i.labels.add(args[k + 1]); if (x === '--remove-label') i.labels.delete(args[k + 1]); });
      return '';
    }
    if (a === 'issue' && b === 'close') { gh.issues.get(num).state = 'CLOSED'; return ''; }
    if (a === 'issue' && b === 'create') {
      const n = gh.next++;
      const labels = new Set(args.filter((x, k) => args[k - 1] === '--label'));
      gh.issues.set(n, { number: n, title: args[args.indexOf('--title') + 1], state: 'OPEN', labels });
      return `https://github.com/me/tidewell/issues/${n}\n`;
    }
    return '';
  };
  /** A worker's PR appears for ticket T<n> (issue) with the given check results. */
  gh.openPr = (n, issue, buckets = ['pass']) => {
    const number = gh.next++;
    gh.prs.push({ number, state: 'OPEN', headRefName: `forge/T${n}`, headRefOid: `sha${number}`, closingIssuesReferences: [{ number: issue }] });
    gh.checks[number] = buckets.map((bucket, i) => ({ name: `c${i}`, bucket }));
    return number;
  };
  return gh;
}

export function fakeSystem() {
  const running = new Set();
  const sys = { started: [], killed: [], ran: [], pid: 1000 };
  sys.git = () => '';
  /** Commands the forge runs itself (npm, wrangler); `respond` answers them, a throw is a failure. */
  sys.respond = () => '';
  sys.run = (cmd, args, cwd) => { sys.ran.push({ cmd, args, cwd }); return sys.respond(cmd, args, cwd); };
  sys.alive = pid => running.has(pid);
  sys.kill = pid => { sys.killed.push(pid); running.delete(pid); };
  sys.spawnClaude = (prompt, cwd, log, tools, env) => { const pid = ++sys.pid; running.add(pid); sys.started.push({ pid, prompt, cwd, log, tools, env }); return pid; };
  /** A detached node script (the demo's preview): it runs until `finishNode` or a test replaces this. */
  sys.nodes = [];
  sys.spawnNode = (script, args, log) => { const pid = ++sys.pid; running.add(pid); sys.nodes.push({ pid, script, args, log }); return pid; };
  sys.finishNode = (out, result) => { fs.writeFileSync(out.args.at(-1), JSON.stringify(result)); running.delete(out.pid); };
  /** A run exits with this result: the newest one, or the newest whose prompt matches `which`. */
  sys.finish = (result, isError = false, which, extra = {}) => {
    const w = [...sys.started].reverse().find(x => running.has(x.pid) && (!which || which.test(x.prompt)));
    fs.writeFileSync(w.log, JSON.stringify({ is_error: isError, result, ...extra }));
    running.delete(w.pid);
  };
  return sys;
}

/** Helpers around one forge whose repo card just went through: stage build, plan T1 <- T2 <- T3. */
export function harness() {
  const NOW = new Date('2026-10-15T09:00:00Z');
  const at = m => new Date(NOW.valueOf() + m * 60_000);
  const ISSUES = { 1: 11, 2: 12, 3: 13 };
  function building({ spec } = {}) {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
    fs.mkdirSync(path.join(v, '_system', 'actions'), { recursive: true });
    fs.writeFileSync(path.join(v, '_system', 'changelog.md'), '');
    fs.writeFileSync(path.join(v, '_system', 'tools.json'), JSON.stringify({ githubOwner: 'me', projectsRoot: path.join(v, 'Projects') }));
    newForge(v, 'Tidy flat', { now: NOW });
    const f = listForges(v)[0];
    fs.writeFileSync(path.join(f.dir, 'plan.md'), PLAN);
    if (spec) fs.writeFileSync(path.join(f.dir, 'spec.md'), spec);
    fs.writeFileSync(f.file, f.text.replace('stage: spec', 'stage: build').replace('name: ""', 'name: "Tidewell"').replace('repo: ""', 'repo: "https://github.com/me/tidewell"').replace('---\n#', `issues: ${JSON.stringify(ISSUES)}\n---\n#`));
    return { v, gh: fakeGitHub(Object.values(ISSUES)), sys: fakeSystem() };
  }
  const pass = (w, m, runClaude = () => ({ ok: true, text: 'UNBLOCK: try again' })) => advanceForges(w.v, { now: at(m), runClaude, run: w.gh.run, sys: w.sys });
  const ticket = (w, n) => loadBuild(w.v, 'tidy-flat').tickets[n];
  const labels = (w, issue) => [...w.gh.issues.get(issue).labels].sort();
  const cardBy = (w, action) => listCards(w.v).filter(c => c.action === action).at(-1);
  const press = (c, status, extra = '') => fs.writeFileSync(c.file, c.text.replace(/^status: .*$/m, `status: ${status}`) + extra);
  return { NOW, at, ISSUES, building, pass, ticket, labels, cardBy, press };
}
