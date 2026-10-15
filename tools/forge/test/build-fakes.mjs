// An in-memory GitHub (issues, labels, PRs, checks) and process system for the build tests.
import fs from 'node:fs';

export function fakeGitHub(issueNumbers) {
  const gh = { issues: new Map(issueNumbers.map(n => [n, { number: n, state: 'OPEN', labels: new Set() }])), prs: [], checks: {}, calls: [], next: 100 };
  gh.run = (args, input) => {
    gh.calls.push({ args, input });
    const [a, b] = args;
    const num = Number(args[2]);
    if (a === 'repo' && b === 'clone') { fs.mkdirSync(args[3], { recursive: true }); return ''; }
    if (a === 'issue' && b === 'list') return JSON.stringify([...gh.issues.values()].map(i => ({ number: i.number, state: i.state, labels: [...i.labels].map(name => ({ name })) })));
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
    if (a === 'issue' && b === 'create') { const n = gh.next++; gh.issues.set(n, { number: n, state: 'OPEN', labels: new Set() }); return `https://github.com/me/tidewell/issues/${n}\n`; }
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
  const sys = { started: [], killed: [], pid: 1000 };
  sys.git = () => '';
  sys.alive = pid => running.has(pid);
  sys.kill = pid => { sys.killed.push(pid); running.delete(pid); };
  sys.spawnClaude = (prompt, cwd, log, tools) => { const pid = ++sys.pid; running.add(pid); sys.started.push({ pid, prompt, cwd, log, tools }); return pid; };
  /** A run exits with this result: the newest one, or the newest whose prompt matches `which`. */
  sys.finish = (result, isError = false, which) => {
    const w = [...sys.started].reverse().find(x => running.has(x.pid) && (!which || which.test(x.prompt)));
    fs.writeFileSync(w.log, JSON.stringify({ is_error: isError, result }));
    running.delete(w.pid);
  };
  return sys;
}
