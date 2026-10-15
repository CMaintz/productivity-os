// Build workers: one detached `claude -p "/feature <issue>"` per ticket, in its own git worktree
// on branch forge/T<n>, writing its JSON result to a log file. The executor never waits on a
// worker; each pass asks whether it's still alive and, once it isn't, reads the result.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export const WORKER_TIMEOUT_H = 3;
const REPO_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(gh:*),Bash(npm:*),Bash(npx:*),Bash(mise:*),Bash(node:*)';
const USAGE_LIMIT = /usage limit|rate limit|limit reached|try again (at|later)/i;

/** Real process plumbing; tests pass fakes with the same shape. */
export const system = {
  git: (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  alive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
  // Detached on POSIX means its own process group, so -pid takes its children (npm, tests) too.
  kill: pid => { try { process.kill(process.platform === 'win32' ? pid : -pid); } catch { try { process.kill(pid); } catch { /* already gone */ } } },
  /** Starts `claude -p` detached with the prompt on stdin and stdout+stderr in logFile. Returns the pid. */
  spawnClaude: (prompt, cwd, logFile) => {
    const out = fs.openSync(logFile, 'w');
    const win = process.platform === 'win32';
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', REPO_TOOLS];
    const child = spawn(process.env.CLAUDE_BIN || 'claude', win ? args.map(a => (/[\s,()*]/.test(a) ? `"${a}"` : a)) : args,
      { cwd, detached: true, stdio: ['pipe', out, out], shell: win, windowsHide: true });
    child.stdin.end(prompt);
    child.unref();
    fs.closeSync(out);
    return child.pid;
  },
};

export const worktreeOf = (clone, n) => path.join(`${clone}-worktrees`, `T${n}`);

/** A fresh worktree on forge/T<n> from origin/main, then the worker. Returns the run record. */
export function startWorker({ clone, n, issueUrl, logDir, now, sys = system }) {
  const wt = worktreeOf(clone, n);
  sys.git(['fetch', '--quiet', 'origin'], clone);
  if (fs.existsSync(wt)) sys.git(['worktree', 'remove', '--force', wt], clone);
  sys.git(['worktree', 'add', '-B', `forge/T${n}`, wt, 'origin/main'], clone);
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `T${n}-${now.valueOf()}.json`);
  const prompt = `/feature ${issueUrl}\n\nYou are in a worktree on branch forge/T${n}. Work only on this ticket, keep Foundry's gate green, and finish with /ship so the PR closes the issue. If you can't finish, label the issue agent:blocked and comment why.`;
  return { pid: sys.spawnClaude(prompt, wt, log), log, started: now.toISOString() };
}

/** 'running', 'timeout', or the finished result { ok, text, usageLimit }. */
export function workerStatus(run, { now, sys = system }) {
  if (sys.alive(run.pid)) return (now - new Date(run.started)) / 36e5 >= WORKER_TIMEOUT_H ? 'timeout' : 'running';
  const raw = fs.existsSync(run.log) ? fs.readFileSync(run.log, 'utf8') : '';
  let out;
  try { out = JSON.parse(raw.slice(raw.indexOf('{'))); } catch { out = { is_error: true, result: raw.trim().slice(-300) || 'no output' }; }
  const text = String(out.result ?? '');
  return { ok: !out.is_error, text, usageLimit: out.is_error && USAGE_LIMIT.test(text) };
}

