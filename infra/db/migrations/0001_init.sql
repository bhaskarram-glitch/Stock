-- infra/db/migrations/0001_init.sql — full schema for self-hosted Postgres (Phase H).
-- Consolidates infra/supabase/0001–0004 into the final state, minus Supabase-only parts:
--   * gen_random_uuid() (built in since PG13) instead of the uuid-ossp extension
--   * no row-level security / `authenticated` / auth.uid() — access is controlled by DB roles:
--       stock_migrator owns the schema and runs migrations; stock_app gets SELECT/INSERT/UPDATE/DELETE
--   * provider_accounts.provider uses the `provider` enum, as in the live Supabase DB (market_provider dropped)
--   * dropped indexes that duplicated a unique constraint or a wider composite index
-- Applied by `npm run db:migrate` (records the version in schema_migrations). Not idempotent on purpose:
-- the runner guarantees it runs once.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type ws_status       as enum ('online', 'offline', 'degraded');
create type data_source     as enum ('ws', 'api', 'hist', 'hist_expired');
create type candle_interval as enum ('1m', '5m', '15m', '1h', '1d');
create type provider        as enum ('upstox', 'groww', 'kite', 'fyers');

create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- instruments — master list, one row per provider instrument key
-- ---------------------------------------------------------------------------
create table instruments (
  id                      uuid primary key default gen_random_uuid(),
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
  underlying_key          text,
  underlying_symbol       text,
  expiry                  date,
  strike                  numeric,
  option_type             text,
  weekly                  boolean,
  is_expired              boolean not null default false,
  is_active               boolean default true,
  metadata                jsonb,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now(),
  constraint instruments_provider_key_unique unique (provider, provider_instrument_key),
  constraint instruments_option_type_check check (option_type is null or option_type in ('CE', 'PE'))
);
create index idx_instruments_underlying_expiry on instruments (underlying_key, expiry);
create index idx_instruments_segment_type      on instruments (segment, instrument_type);
create index idx_instruments_expiry_active     on instruments (expiry) where is_expired = false;
create trigger trg_instruments_updated_at before update on instruments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- market_candles — the time series
-- ---------------------------------------------------------------------------
create table market_candles (
  id             uuid primary key default gen_random_uuid(),
  instrument_id  uuid not null references instruments (id) on delete cascade,
  instrument_key text not null,
  interval       candle_interval not null,
  bucket_start   timestamptz not null,
  open           numeric not null,
  high           numeric not null,
  low            numeric not null,
  close          numeric not null,
  volume         numeric,
  oi             numeric,
  source         data_source not null default 'ws',
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  -- also serves "latest candles for key+interval" (btree scans backwards)
  constraint market_candles_instrument_key_interval_bucket_start_key unique (instrument_key, interval, bucket_start)
);
create index idx_market_candles_instrument_id_interval_time on market_candles (instrument_id, interval, bucket_start desc);
create trigger trg_market_candles_updated_at before update on market_candles
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- instrument_status — live feed health per instrument
-- ---------------------------------------------------------------------------
create table instrument_status (
  instrument_key text primary key,
  ws_status      ws_status not null default 'offline',
  last_ws_ts     timestamptz,
  last_api_ts    timestamptz,
  heartbeat_ts   timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index idx_instrument_status_ws_status on instrument_status (ws_status);
create trigger trg_instrument_status_updated_at before update on instrument_status
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- ws_failures — outage audit log
-- ---------------------------------------------------------------------------
create table ws_failures (
  id             uuid primary key default gen_random_uuid(),
  instrument_key text not null,
  failure_type   text not null,
  failure_ts     timestamptz not null default now(),
  error_message  text,
  recovered_ts   timestamptz,
  created_at     timestamptz default now()
);
create index idx_ws_failures_failure_ts     on ws_failures (failure_ts desc);
create index idx_ws_failures_instrument_key on ws_failures (instrument_key);

-- ---------------------------------------------------------------------------
-- backfill_state — per-instrument watermarks; every run resumes from last_date + 1
-- ---------------------------------------------------------------------------
create table backfill_state (
  instrument_key text not null,
  interval       candle_interval not null,
  first_date     date,
  last_date      date,
  is_final       boolean not null default false,  -- expired contract loaded through expiry: never refetch
  rows_written   integer not null default 0,
  attempts       integer not null default 0,
  last_error     text,
  last_run_at    timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  primary key (instrument_key, interval)
);
create index idx_backfill_state_pending on backfill_state (interval, last_date) where is_final = false;
create index idx_backfill_state_errors  on backfill_state (last_run_at desc) where last_error is not null;
create trigger trg_backfill_state_updated_at before update on backfill_state
  for each row execute function set_updated_at();

-- underlying_expiries — which expiries have had their contracts enumerated
create table underlying_expiries (
  underlying_key   text not null,
  expiry           date not null,
  contracts_loaded boolean not null default false,
  option_count     integer not null default 0,
  future_count     integer not null default 0,
  loaded_at        timestamptz,
  created_at       timestamptz default now(),
  primary key (underlying_key, expiry)
);
create index idx_underlying_expiries_pending on underlying_expiries (underlying_key) where contracts_loaded = false;

-- ---------------------------------------------------------------------------
-- provider_accounts / watchlists — reserved for the future API/web app.
-- Worker tokens stay in env, never here. No auth.users FK: there is no Supabase Auth any more.
-- ---------------------------------------------------------------------------
create table provider_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  provider         provider,
  provider_user_id text not null,
  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create trigger trg_provider_accounts_updated_at before update on provider_accounts
  for each row execute function set_updated_at();

create table watchlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  name       text not null,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Grants. Default privileges (set when the roles were created) already cover tables made by
-- stock_migrator; these explicit grants also cover a DB where that step was skipped (e.g. dev).
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'stock_app') then
    grant usage on schema public to stock_app;
    grant select, insert, update, delete on all tables in schema public to stock_app;
    grant usage, select on all sequences in schema public to stock_app;
  end if;
end $$;
