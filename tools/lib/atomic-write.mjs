// Rewrites a file so a concurrent reader (Obsidian, the MCP server, the snapshot) sees
// either the old content or the new, never a truncated half: the data goes to a temp
// file in the same directory (same volume, so the rename is atomic) and is renamed
// over the target.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Windows refuses a rename while another process (Obsidian, OneDrive, an antivirus
// scan, any reader) has the target open. Each hold is short, but under a busy reader
// they come in streaks of a few hundred ms, so the budget is time, not attempts.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DEFAULT_RETRY_MS = 3000;
const MAX_DELAY_MS = 100;

// A dotfile so Obsidian never indexes it; the .tmp suffix keeps it out of every
// .md/.json scan in tools/.
const tempPathFor = file =>
  path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameWithRetry(from, to, retryMs) {
  const deadline = Date.now() + retryMs;
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!RETRY_CODES.has(e.code) || Date.now() >= deadline) throw e;
    }
    sleepSync(Math.min(10 * 2 ** attempt, MAX_DELAY_MS));
  }
}

// Renaming over a symlink would replace the link itself, and the temp would bring the
// default mode; an in-place write kept both (e.g. a 0600 settings.json linked from dotfiles).
function existingTarget(file) {
  try { return { target: fs.realpathSync(file), mode: fs.statSync(file).mode & 0o7777 }; } catch { return { target: file }; }
}

/**
 * Replaces `file` with `data` atomically. On any failure the original is left as it
 * was, the temp file is removed, and the error is rethrown. `retryMs` caps how long
 * a locked target is waited on (synchronously); 0 for callers that must never block.
 */
export function writeFileAtomic(file, data, { retryMs = DEFAULT_RETRY_MS } = {}) {
  const { target, mode } = existingTarget(file);
  const temp = tempPathFor(target);
  try {
    fs.writeFileSync(temp, data, { flag: 'wx', mode });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    renameWithRetry(temp, target, retryMs);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}
