-- Adds IMDb details to titles. Run once in Supabase -> SQL Editor.
alter table public.titles
  add column if not exists imdb_id text,
  add column if not exists poster_url text,
  add column if not exists imdb_rating numeric(3,1);
