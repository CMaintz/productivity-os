-- Runtime errors from code widgets on the dashboard. The browser reports one row per crashing
-- widget per page load: the widget id and a short message, never row data. The main PC reads
-- them and switches a widget off after repeated crashes (tools/widgets/code-widgets.mjs).

create table if not exists public.widget_errors (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  widget_id  text not null check (widget_id ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  message    text not null default '' check (char_length(message) <= 200),
  created_at timestamptz not null default now()
);

create index if not exists widget_errors_recent on public.widget_errors (owner_id, created_at);

revoke all on public.widget_errors from anon, authenticated;
grant insert (widget_id, message) on public.widget_errors to authenticated;

alter table public.widget_errors enable row level security;

drop policy if exists "owner reports errors" on public.widget_errors;
create policy "owner reports errors" on public.widget_errors
  for insert to authenticated with check (owner_id = auth.uid());

-- No select/update/delete for the browser: only the PC (service role) reads and prunes them.
-- At most 10 reports a minute per owner.
-- security definer: the browser can't select from the table, but the count must see its rows.
create or replace function public.widget_errors_rate_limit() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.widget_errors
      where owner_id = new.owner_id and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'rate limit: too many widget errors';
  end if;
  return new;
end $$;

drop trigger if exists widget_errors_rate_limit on public.widget_errors;
create trigger widget_errors_rate_limit before insert on public.widget_errors
  for each row execute function public.widget_errors_rate_limit();
