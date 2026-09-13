-- 0001_baseline.sql — captures the schema that exists in the live Supabase project as of 2026-09-13.
-- Idempotent: safe to run on the live DB (no-op) and on a fresh Postgres (creates everything).
-- Apply: Supabase SQL editor, or `psql "$DATABASE_URL" -f infra/supabase/migrations/0001_baseline.sql`.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'ws_status') then
    create type ws_status as enum ('online', 'offline', 'degraded');
  end if;
  if not exists (select 1 from pg_type where typname = 'data_source') then
    create type data_source as enum ('ws', 'api');
  end if;
  if not exists (select 1 from pg_type where typname = 'candle_interval') then
    create type candle_interval as enum ('1m', '5m', '15m', '1h', '1d');
  end if;
  if not exists (select 1 from pg_type where typname = 'market_provider') then
    create type market_provider as enum ('upstox');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger (shared)
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- instruments — master list, one row per provider instrument key
-- ---------------------------------------------------------------------------
create table if not exists instruments (
  id                      uuid primary key default uuid_generate_v4(),
  provider                text not null,
  provider_instrument_key text not null,
  exchange                text not null,
  segment                 text not null,
  trading_symbol          text not null,
  name                    text not null,
  isin                    text,
  instrument_type         text,
  exchange_token          text,
  tick_size               numeric,
  lot_size                integer,
  is_active               boolean default true,
  metadata                jsonb,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now(),
  constraint instruments_provider_key_unique unique (provider, provider_instrument_key)
);

-- ---------------------------------------------------------------------------
-- market_candles — the time series
-- ---------------------------------------------------------------------------
create table if not exists market_candles (
  id             uuid primary key default uuid_generate_v4(),
  instrument_id  uuid not null,
  instrument_key text not null,
  interval       candle_interval not null,
  bucket_start   timestamptz not null,
  open           numeric not null,
  high           numeric not null,
  low            numeric not null,
  close          numeric not null,
  volume         numeric,
  source         data_source not null default 'ws',
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  constraint market_candles_instrument_key_interval_bucket_start_key unique (instrument_key, interval, bucket_start)
);
create index if not exists idx_market_candles_bucket_start on market_candles (bucket_start desc);
create index if not exists idx_market_candles_instrument_id on market_candles (instrument_id);
create index if not exists idx_market_candles_instrument_key_interval_time on market_candles (instrument_key, interval, bucket_start desc);

-- ---------------------------------------------------------------------------
-- instrument_status — live feed health per instrument
-- ---------------------------------------------------------------------------
create table if not exists instrument_status (
  instrument_key text primary key,
  ws_status      ws_status not null default 'offline',
  last_ws_ts     timestamptz,
  last_api_ts    timestamptz,
  heartbeat_ts   timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index if not exists idx_instrument_status_last_ws_ts on instrument_status (last_ws_ts desc);
create index if not exists idx_instrument_status_ws_status on instrument_status (ws_status);

-- ---------------------------------------------------------------------------
-- ws_failures — outage audit log
-- ---------------------------------------------------------------------------
create table if not exists ws_failures (
  id             uuid primary key default uuid_generate_v4(),
  instrument_key text not null,
  failure_type   text not null,
  failure_ts     timestamptz not null default now(),
  error_message  text,
  recovered_ts   timestamptz,
  created_at     timestamptz default now()
);
create index if not exists idx_ws_failures_failure_ts on ws_failures (failure_ts desc);
create index if not exists idx_ws_failures_instrument_key on ws_failures (instrument_key);
create index if not exists idx_ws_failures_recovered_ts on ws_failures (recovered_ts) where recovered_ts is not null;

-- ---------------------------------------------------------------------------
-- provider_accounts / watchlists — user-facing (future API/web). Kept as-is.
-- NOTE: worker tokens live in env (account registry), never here.
-- ---------------------------------------------------------------------------
create table if not exists provider_accounts (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null,
  provider         market_provider,
  provider_user_id text not null,
  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create table if not exists watchlists (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null,
  name       text not null,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Foreign keys (guarded — the live DB may or may not already have them)
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'market_candles_instrument_id_fkey') then
    alter table market_candles
      add constraint market_candles_instrument_id_fkey
      foreign key (instrument_id) references instruments (id) on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists trg_instruments_updated_at on instruments;
create trigger trg_instruments_updated_at before update on instruments for each row execute function set_updated_at();
drop trigger if exists trg_market_candles_updated_at on market_candles;
create trigger trg_market_candles_updated_at before update on market_candles for each row execute function set_updated_at();
drop trigger if exists trg_instrument_status_updated_at on instrument_status;
create trigger trg_instrument_status_updated_at before update on instrument_status for each row execute function set_updated_at();
drop trigger if exists trg_provider_accounts_updated_at on provider_accounts;
create trigger trg_provider_accounts_updated_at before update on provider_accounts for each row execute function set_updated_at();