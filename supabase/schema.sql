-- Tell Me Calories schema for Supabase. Run once in the Supabase SQL Editor (safe to re-run).

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  token_hash text primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_id_idx on public.sessions (user_id);

create table if not exists public.meals (
  id uuid primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  meal_date date not null,
  meal_name text not null,
  portion text not null,
  model text not null,
  calories integer not null,
  protein real not null,
  carbs real not null,
  fat real not null,
  analysis jsonb not null,
  thumbnail_path text
);
create index if not exists meals_user_date_idx on public.meals (user_id, meal_date);

-- Lock every table down. The backend uses the service key, which bypasses RLS.
-- The public anon key gets no access at all.
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.meals enable row level security;

-- Private bucket for meal thumbnails. The backend also creates this on startup.
insert into storage.buckets (id, name, public)
values ('meal-thumbnails', 'meal-thumbnails', false)
on conflict (id) do nothing;
