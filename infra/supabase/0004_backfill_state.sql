-- 0004_backfill_state.sql — watermark tracking so every backfill run only fetches what's missing.
-- Replaces backfill_jobs (created in 0002, never used): a per-range job table doesn't express
-- "resume from the last date I have", which is what the runner actually needs.

drop table if exists backfill_jobs;

create table if not exists backfill_state (
  instrument_key text not null,
  interval       candle_interval not null,
  -- Data is complete for [first_date, last_date]. Next run starts at last_date + 1 day.
  first_date     date,
  last_date      date,
  -- Expired contracts never gain new candles: once loaded through expiry, this is set and
  -- the runner skips the instrument forever. This is the main cost saving on re-runs.
  is_final       boolean not null default false,
  rows_written   integer not null default 0,
  attempts       integer not null default 0,
  last_error     text,
  last_run_at    timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  primary key (instrument_key, interval)
);

create index if not exists idx_backfill_state_pending on backfill_state (interval, last_date) where is_final = false;
create index if not exists idx_backfill_state_errors on backfill_state (last_run_at desc) where last_error is not null;

drop trigger if exists trg_backfill_state_updated_at on backfill_state;
create trigger trg_backfill_state_updated_at before update on backfill_state
  for each row execute function set_updated_at();

-- Expiry dates per underlying, so a re-run doesn't re-enumerate contracts it already has.
create table if not exists underlying_expiries (
  underlying_key   text not null,
  expiry           date not null,
  contracts_loaded boolean not null default false,
  option_count     integer not null default 0,
  future_count     integer not null default 0,
  loaded_at        timestamptz,
  created_at       timestamptz default now(),
  primary key (underlying_key, expiry)
);
create index if not exists idx_underlying_expiries_pending on underlying_expiries (underlying_key) where contracts_loaded = false;