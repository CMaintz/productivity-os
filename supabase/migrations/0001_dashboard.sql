-- productivity-os dashboard (dash.maintz.dev). Use a Supabase project of its own.
--
-- snapshot:    one row per owner, written by the main PC (service role) with metadata
--              only: titles, statuses, counts. No note bodies or prompts.
-- card_events: button presses from the dashboard. The PC applies them to the card
--              notes in the vault and marks them applied. The browser can only insert
--              its own events and read them back.
-- RLS limits everything to the owner's auth user; nothing is public.

create table if not exists public.snapshot (
  owner_id   uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.card_events (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  card_file   text not null check (card_file ~ '^_system/actions/[^/]+\.md$'),
  card_key    text not null check (char_length(card_key) between 1 and 300),
  status      text not null check (status in ('approved', 'snoozed', 'rejected', 'undone')),
  always      boolean not null default false,
  never       boolean not null default false,
  reason      text not null default '' check (char_length(reason) <= 200),
  -- Same combinations the Meta Bind buttons produce: Always approves, Never rejects.
  check ((not always or status = 'approved') and (not never or status = 'rejected')),
  created_at  timestamptz not null default now(),
  applied_at  timestamptz,
  outcome     text
);

create index if not exists card_events_pending on public.card_events (owner_id) where applied_at is null;

-- Explicit grants (don't rely on project defaults): the browser can read both tables
-- and insert events; RLS below narrows that to the owner's own rows. anon gets nothing.
revoke all on public.snapshot, public.card_events from anon, authenticated;
grant select on public.snapshot to authenticated;
grant select, insert (card_file, card_key, status, always, never, reason) on public.card_events to authenticated;

alter table public.snapshot enable row level security;
alter table public.card_events enable row level security;

drop policy if exists "owner reads snapshot" on public.snapshot;
create policy "owner reads snapshot" on public.snapshot
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists "owner reads events" on public.card_events;
create policy "owner reads events" on public.card_events
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists "owner adds events" on public.card_events;
create policy "owner adds events" on public.card_events
  for insert to authenticated with check (owner_id = auth.uid() and applied_at is null and outcome is null);

-- No update/delete policies: only the PC (service role, which bypasses RLS) changes rows.
-- At most 30 presses a minute per owner, so a stuck page can't flood the queue.
create or replace function public.card_events_rate_limit() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.card_events
      where owner_id = new.owner_id and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate limit: too many card events';
  end if;
  return new;
end $$;

drop trigger if exists card_events_rate_limit on public.card_events;
create trigger card_events_rate_limit before insert on public.card_events
  for each row execute function public.card_events_rate_limit();

-- Live updates in the dashboard when the PC publishes a new snapshot or applies an event.
do $$ begin
  alter publication supabase_realtime add table public.snapshot, public.card_events;
exception when duplicate_object or undefined_object then null; end $$;
