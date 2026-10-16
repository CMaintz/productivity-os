// The usage recorder: Claude Code's status line hands it rate_limits on stdin; it writes
// _system/usage.json for the Product Forge's pacing, and keeps any status line you already had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { usageFromStatus } from '../statusline.mjs';
import { withStatusLine, withoutStatusLine } from '../install.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'statusline.mjs');
const NOW = new Date('2026-10-15T09:00:00Z');
const epoch = iso => Date.parse(iso) / 1000;
const status = (five, week) => ({ session_id: 's', model: { display_name: 'Opus' }, rate_limits: {
  ...(five ? { five_hour: { used_percentage: five[0], resets_at: epoch(five[1]) } } : {}),
  ...(week ? { seven_day: { used_percentage: week[0], resets_at: epoch(week[1]) } } : {}),
} });

test('usage: both windows recorded; the reset that matters is the fuller window\'s', () => {
  assert.deepEqual(usageFromStatus(status([85, '2026-10-15T11:00:00Z'], [40, '2026-10-20T00:00:00Z']), NOW),
    { fiveHourPct: 85, weeklyPct: 40, resetsAt: '2026-10-15T11:00:00.000Z', recordedAt: NOW.toISOString() });
  assert.equal(usageFromStatus(status([10, '2026-10-15T11:00:00Z'], [92, '2026-10-20T00:00:00Z']), NOW).resetsAt, '2026-10-20T00:00:00.000Z');
  assert.equal(usageFromStatus(status(null, [50, '2026-10-20T00:00:00Z']), NOW).fiveHourPct, null, 'a window Claude Code dropped is unknown, not 0');
  assert.equal(usageFromStatus({ session_id: 's' }, NOW), null, 'no rate_limits (API key, or before the first reply): nothing to record');
});

function run(payload, { vault, chain } = {}) {
  const args = [SCRIPT, ...(chain ? ['--chain', Buffer.from(JSON.stringify({ command: chain })).toString('base64')] : [])];
  return spawnSync(process.execPath, args, { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, PRODUCTIVITY_VAULT: vault } });
}

test('statusline script writes usage.json and prints a short line; keeps the old file when there is nothing new', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  fs.mkdirSync(path.join(vault, '_system'));
  const r = run(status([62, '2026-10-15T11:00:00Z'], [30, '2026-10-20T00:00:00Z']), { vault });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /62%.*30%/);
  const file = path.join(vault, '_system', 'usage.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fiveHourPct, 62);
  run({ session_id: 's' }, { vault });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fiveHourPct, 62, 'a payload without rate_limits leaves the last record');
});

test('statusline script chains your existing status line: same stdin, its output shown', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  fs.mkdirSync(path.join(vault, '_system'));
  const prev = `"${process.execPath}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('mine:'+JSON.parse(s).model.display_name))"`;
  const r = run(status([5, '2026-10-15T11:00:00Z']), { vault, chain: prev });
  assert.equal(r.stdout.trim(), 'mine:Opus');
  assert.ok(fs.existsSync(path.join(vault, '_system', 'usage.json')), 'and still records usage');
});

test('installer: sets the recorder, chains an existing status line, and uninstall restores it', () => {
  const mine = { statusLine: { type: 'command', command: 'bash ~/my-line.sh', padding: 1 }, theme: 'dark' };
  const installed = withStatusLine(mine, 'node "/pos/tools/hooks/statusline.mjs"');
  assert.match(installed.statusLine.command, /^node "\/pos\/tools\/hooks\/statusline\.mjs" --chain \S+$/);
  assert.equal(installed.statusLine.refreshInterval, 60, 'refreshes while idle, so the record stays current');
  assert.deepEqual(withStatusLine(installed, 'node "/pos/tools/hooks/statusline.mjs"'), installed, 'idempotent: never chains itself');
  assert.deepEqual(withoutStatusLine(installed), mine);
  assert.deepEqual(withoutStatusLine(withStatusLine({}, 'node "/x/statusline.mjs"')), {});
  const ticking = { statusLine: { type: 'command', command: 'my-line', refreshInterval: 5 } };
  assert.equal(withStatusLine(ticking, 'node "/x/statusline.mjs"').statusLine.refreshInterval, 5, 'a faster refresh you set is kept');
  assert.deepEqual(withoutStatusLine(withStatusLine(ticking, 'node "/x/statusline.mjs"')), ticking);
});
