-- Couch Club database setup
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run.
-- Before running, change the club code in section 1 (search for "change this code").
-- Safe to run again: it only adds what's missing and never deletes data.

------------------------------------------------------------------
-- 1. Who is in the club (only these emails can see or change anything)
------------------------------------------------------------------
create table if not exists public.allowed_emails (
  email text primary key
);

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- Self sign-up: one settings row holding the club code.
-- join_code set   → people join by signing in and entering this code.
-- join_code null  → anyone who signs in joins automatically (fully open).
create table if not exists public.club_settings (
  id        int primary key default 1 check (id = 1),
  join_code text
);
insert into public.club_settings (id, join_code) values (1, 'movie-night')   -- ← change this code
on conflict (id) do nothing;

-- Does joining need a code? (lets the app hide the code box when the club is open)
create or replace function public.club_needs_code()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select join_code is not null and join_code <> '' from public.club_settings where id = 1), false);
$$;

-- Join the club: adds the signed-in person's email to the list if the code matches
create or replace function public.join_club(code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  expected text;
  my_email text := lower(auth.jwt() ->> 'email');
begin
  if auth.uid() is null or my_email is null or my_email = '' then
    return false;
  end if;
  select join_code into expected from public.club_settings where id = 1;
  if expected is not null and expected <> ''
     and lower(trim(coalesce(code, ''))) <> lower(trim(expected)) then
    return false;
  end if;
  insert into public.allowed_emails (email) values (my_email) on conflict do nothing;
  return true;
end;
$$;

revoke all on function public.club_needs_code() from public, anon;
revoke all on function public.join_club(text)   from public, anon;
grant execute on function public.club_needs_code() to authenticated;
grant execute on function public.join_club(text)   to authenticated;

------------------------------------------------------------------
-- 2. Tables
------------------------------------------------------------------
create table if not exists public.profiles (
  id        uuid primary key references auth.users (id) on delete cascade,
  nickname  text not null check (char_length(nickname) between 1 and 30),
  joined_at timestamptz not null default now()
);

create table if not exists public.titles (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (char_length(title) between 1 and 120),
  kind           text not null default 'movie' check (kind in ('movie', 'series')),
  year           int check (year between 1880 and 2100),
  where_to_watch text check (char_length(where_to_watch) <= 60),
  note           text check (char_length(note) <= 200),
  added_by       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  added_at       timestamptz not null default now()
);

create unique index if not exists titles_title_unique on public.titles (lower(title));

-- One row per person per title: whether they've seen it, and their one-line take
create table if not exists public.views (
  title_id uuid not null references public.titles (id) on delete cascade,
  user_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  seen     boolean not null default true,
  seen_at  timestamptz default now(),
  take     text check (char_length(take) <= 280),
  primary key (title_id, user_id)
);

grant select, insert, update, delete on public.profiles, public.titles, public.views to authenticated;

------------------------------------------------------------------
-- 3. Access rules (Row Level Security)
------------------------------------------------------------------
alter table public.allowed_emails enable row level security;  -- no policies: the app can't read or edit it
alter table public.club_settings  enable row level security;  -- no policies: the code stays secret
alter table public.profiles       enable row level security;
alter table public.titles         enable row level security;
alter table public.views          enable row level security;

drop policy if exists "members read profiles"  on public.profiles;
drop policy if exists "members add own profile" on public.profiles;
drop policy if exists "members edit own profile" on public.profiles;
create policy "members read profiles"   on public.profiles for select to authenticated using (public.is_member());
create policy "members add own profile" on public.profiles for insert to authenticated with check (public.is_member() and id = auth.uid());
create policy "members edit own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (public.is_member() and id = auth.uid());

drop policy if exists "members read titles"       on public.titles;
drop policy if exists "members add titles"        on public.titles;
drop policy if exists "adders remove their titles" on public.titles;
create policy "members read titles"        on public.titles for select to authenticated using (public.is_member());
create policy "members add titles"         on public.titles for insert to authenticated with check (public.is_member() and added_by = auth.uid());
create policy "adders remove their titles" on public.titles for delete to authenticated using (public.is_member() and added_by = auth.uid());

drop policy if exists "members read views"   on public.views;
drop policy if exists "members add own view" on public.views;
drop policy if exists "members edit own view" on public.views;
drop policy if exists "members delete own view" on public.views;
create policy "members read views"      on public.views for select to authenticated using (public.is_member());
create policy "members add own view"    on public.views for insert to authenticated with check (public.is_member() and user_id = auth.uid());
create policy "members edit own view"   on public.views for update to authenticated using (user_id = auth.uid()) with check (public.is_member() and user_id = auth.uid());
create policy "members delete own view" on public.views for delete to authenticated using (user_id = auth.uid());

------------------------------------------------------------------
-- 4. Live updates (so ticks appear for everyone without reloading)
------------------------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table public.titles;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.views;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
end $$;

------------------------------------------------------------------
-- 5. Optional: add people by email in advance (they then skip the code).
--    Everyone else joins themselves with the club code from section 1.
------------------------------------------------------------------
-- insert into public.allowed_emails (email) values ('you@example.com') on conflict do nothing;
