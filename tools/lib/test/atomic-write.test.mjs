import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { writeFileAtomic } from '../atomic-write.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
const busy = () => Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });

// Reads the file over and over on another thread until told to stop, and reports the
// length of every content it saw. It spins a random few ms between reads like a real
// reader: one that keeps the file open nonstop starves the rename on Windows, and a
// timer sleep would lock step with the writer's retries on the same clock tick. Read
// errors (a Windows rename in flight) are not partial content, so they are not counted.
const READER = `
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const seen = new Set(); let stop = false;
const pause = () => { const end = performance.now() + 1 + Math.random() * 4; while (performance.now() < end); };
parentPort.on('message', () => { stop = true; });
const loop = () => {
  for (let i = 0; i < 20; i++) {
    try { seen.add(fs.readFileSync(workerData, 'utf8').length); } catch { /* a rename in flight */ }
    pause();
  }
  if (stop) parentPort.postMessage({ lengths: [...seen] }); else setImmediate(loop);
};
parentPort.postMessage('reading');
loop();
`;

async function readWhileWriting(file, writes) {
  const worker = new Worker(READER, { eval: true, workerData: file });
  const next = () => new Promise(resolve => worker.once('message', resolve));
  try {
    await next();
    const done = next();
    writes();
    worker.postMessage('stop');
    return await done;
  } finally {
    await worker.terminate();
  }
}

test('a reader running during repeated rewrites only ever sees a complete file', async () => {
  const file = path.join(tmpDir(), 'policy.md');
  const big = 'a'.repeat(1e6);
  const small = 'b'.repeat(1e3);
  fs.writeFileSync(file, small);
  const r = await readWhileWriting(file, () => {
    for (let i = 0; i < 60; i++) writeFileAtomic(file, i % 2 ? small : big);
  });
  assert.deepEqual(
    r.lengths.filter(n => n !== big.length && n !== small.length),
    [],
    'saw a partial file',
  );
  assert.ok(r.lengths.includes(big.length) && r.lengths.includes(small.length), 'the reader never overlapped the writes');
});

test('a write whose temp file fails part-way leaves the original intact and no temp behind', t => {
  const dir = tmpDir();
  const file = path.join(dir, 'policy.md');
  fs.writeFileSync(file, 'original');
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (f, data, ...rest) => {
    real(f, String(data).slice(0, 3), ...rest);
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  });
  assert.throws(() => writeFileAtomic(file, 'replacement'), { code: 'ENOSPC' });
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(dir), ['policy.md']);
});

test('a target that stays locked fails the write, keeps the original and cleans up the temp', t => {
  const dir = tmpDir();
  const file = path.join(dir, 'policy.md');
  fs.writeFileSync(file, 'original');
  t.mock.method(fs, 'renameSync', () => {
    throw busy();
  });
  assert.throws(() => writeFileAtomic(file, 'replacement'), { code: 'EBUSY' });
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(dir), ['policy.md']);
});

test('a briefly locked target (Obsidian or OneDrive holding it) is retried until the rename lands', t => {
  const dir = tmpDir();
  const file = path.join(dir, 'policy.md');
  fs.writeFileSync(file, 'original');
  const real = fs.renameSync;
  let calls = 0;
  t.mock.method(fs, 'renameSync', (a, b) =>
    ++calls < 3
      ? (() => {
          throw busy();
        })()
      : real(a, b),
  );
  writeFileAtomic(file, 'replacement');
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
  assert.deepEqual(fs.readdirSync(dir), ['policy.md']);
});

test('a caller that must not block (the status line) gives up on a locked target at once', t => {
  const file = path.join(tmpDir(), 'usage.json');
  fs.writeFileSync(file, 'original');
  t.mock.method(fs, 'renameSync', () => {
    throw busy();
  });
  const started = Date.now();
  assert.throws(() => writeFileAtomic(file, 'replacement', { retryMs: 0 }), { code: 'EBUSY' });
  assert.ok(Date.now() - started < 500, 'waited on the lock');
});

// chmod and unprivileged symlinks don't work on Windows; CI (Linux) runs this one.
test('rewriting through a symlink keeps the link and the file mode', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const real = path.join(dir, 'settings.real.json');
  const link = path.join(dir, 'settings.json');
  fs.writeFileSync(real, 'original');
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, link);
  writeFileAtomic(link, 'replacement');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, 'utf8'), 'replacement');
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
});
