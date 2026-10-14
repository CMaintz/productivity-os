// Runs supabase/migrations/0001_dashboard.sql in an in-process Postgres (PGlite) with a
// small stand-in for Supabase's roles and auth schema, then checks the access rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ME = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-00000000000b';
const STUB = `
  create role anon nologin; create role authenticated nologin;
  create schema auth; grant usage on schema auth, public to anon, authenticated;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  insert into auth.users values ('${ME}'), ('${OTHER}');`;

async function db() {
  const d = new PGlite();
  await d.exec(STUB);
  await d.exec(fs.readFileSync('supabase/migrations/0001_dashboard.sql', 'utf8'));
  await d.exec(`insert into public.snapshot (owner_id, data) values ('${ME}', '{"mine":true}'), ('${OTHER}', '{"theirs":true}')`);
  return d;
}

async function as(d, role, user, sql, params) {
  await d.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false);`);
  try { return await d.query(sql, params); } finally { await d.exec('reset role;'); }
}
const fails = p => p.then(() => false, () => true);
const event = (d, user, file = '_system/actions/2026-10-14-x.md', status = 'approved', extra = '') =>
  as(d, 'authenticated', user, `insert into public.card_events (card_file, card_key, status${extra ? ', applied_at' : ''}) values ($1, 'k', $2${extra ? ', now()' : ''})`, [file, status]);

test('snapshot: owner reads only their own row; anon reads nothing; clients cannot write', async () => {
  const d = await db();
  const mine = await as(d, 'authenticated', ME, 'select data from public.snapshot');
  assert.deepEqual(mine.rows.map(r => r.data), [{ mine: true }]);
  assert.ok(await fails(as(d, 'anon', null, 'select * from public.snapshot')));
  assert.ok(await fails(as(d, 'authenticated', ME, `update public.snapshot set data = '{}'`)));
  assert.ok(await fails(as(d, 'authenticated', ME, `insert into public.snapshot (owner_id, data) values ('${ME}', '{}')`)));
});

test('card_events: own inserts only, valid values only, never pre-applied, no update/delete', async () => {
  const d = await db();
  assert.equal(await fails(event(d, ME)), false, 'a normal press works');
  assert.ok(await fails(as(d, 'anon', null, `insert into public.card_events (card_file, card_key, status) values ('_system/actions/a.md', 'k', 'approved')`)));
  assert.ok(await fails(as(d, 'authenticated', ME, `insert into public.card_events (owner_id, card_file, card_key, status) values ('${OTHER}', '_system/actions/a.md', 'k', 'approved')`)), 'cannot press for someone else');
  assert.ok(await fails(event(d, ME, '../../etc/passwd')), 'card_file must be a card');
  assert.ok(await fails(event(d, ME, '_system/actions/a.md', 'done')), 'status must be a button value');
  assert.ok(await fails(event(d, ME, '_system/actions/a.md', 'approved', 'pre-applied')), 'cannot mark applied');
  assert.ok(await fails(as(d, 'authenticated', ME, `insert into public.card_events (card_file, card_key, status, always) values ('_system/actions/a.md', 'k', 'snoozed', true)`)), 'always only with approve');
  assert.ok(await fails(as(d, 'authenticated', ME, `insert into public.card_events (card_file, card_key, status, never) values ('_system/actions/a.md', 'k', 'undone', true)`)), 'never only with reject');
  assert.ok(await fails(as(d, 'authenticated', ME, `insert into public.card_events (card_file, card_key, status) values ('_system/actions/a.md', repeat('k', 301), 'approved')`)), 'key length capped');
  assert.ok(await fails(as(d, 'authenticated', ME, `update public.card_events set applied_at = now()`)));
  assert.ok(await fails(as(d, 'authenticated', ME, `delete from public.card_events`)));
  await event(d, OTHER);
  const seen = await as(d, 'authenticated', ME, 'select owner_id from public.card_events');
  assert.deepEqual([...new Set(seen.rows.map(r => r.owner_id))], [ME], 'reads only own events');
});

test('card_events: 30 presses a minute per owner', async () => {
  const d = await db();
  for (let i = 0; i < 30; i++) await event(d, ME);
  assert.ok(await fails(event(d, ME)));
  assert.equal(await fails(event(d, OTHER)), false, 'limit is per owner');
});
