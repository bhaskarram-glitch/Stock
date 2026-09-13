-- 0002_fno.sql — F&O support: typed contract columns, OI on candles, historical sources, backfill tracking, RLS.
-- Idempotent. Requires 0001.

-- ---------------------------------------------------------------------------
-- 1. Enum extensions (ADD VALUE IF NOT EXISTS is idempotent; new values are usable from the next statement)
-- ---------------------------------------------------------------------------
alter type candle_interval add value if not exists '1h';
alter type candle_interval add value if not exists '1d';
alter type data_source add value if not exists 'hist';
alter type data_source add value if not exists 'hist_expired';

-- ---------------------------------------------------------------------------
-- 2. instruments — promote F&O fields out of metadata
-- ---------------------------------------------------------------------------
alter table instruments
  add column if not exists underlying_key    text,
  add column if not exists underlying_symbol text,
  add column if not exists expiry            date,
  add column if not exists strike            numeric,
  add column if not exists option_type       text,
  add column if not exists weekly            boolean,
  add column if not exists is_expired        boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'instruments_option_type_check') then
    alter table instruments add constraint instruments_option_type_check
      check (option_type is null or option_type in ('CE', 'PE'));
  end if;
end $$;

create index if not exists idx_instruments_underlying_expiry on instruments (underlying_key, expiry);
create index if not exists idx_instruments_segment_type on instruments (segment, instrument_type);
create index if not exists idx_instruments_expiry_active on instruments (expiry) where is_expired = false;

-- Backfill the new columns from metadata written by sync-instruments (Phase 0).
-- Upstox `expiry` is epoch milliseconds; contracts expire at IST end of day, so convert in IST.
update instruments set
  underlying_key    = coalesce(underlying_key,    nullif(metadata->>'underlying_key', '')),
  underlying_symbol = coalesce(underlying_symbol, nullif(metadata->>'underlying_symbol', '')),
  strike            = coalesce(strike,            nullif(metadata->>'strike_price', '')::numeric),
  option_type       = coalesce(option_type,       case when instrument_type in ('CE', 'PE') then instrument_type end),
  weekly            = coalesce(weekly,            (metadata->>'weekly')::boolean),
  expiry            = coalesce(expiry,
                        case when metadata->>'expiry' ~ '^\d+$'
                             then (to_timestamp((metadata->>'expiry')::bigint / 1000.0) at time zone 'Asia/Kolkata')::date
                        end)
where metadata is not null
  and (underlying_key is null or expiry is null or strike is null or option_type is null);

update instruments
set is_expired = true
where expiry is not null and expiry < (now() at time zone 'Asia/Kolkata')::date and is_expired = false;

-- ---------------------------------------------------------------------------
-- 3. market_candles — open interest
-- ---------------------------------------------------------------------------
alter table market_candles add column if not exists oi numeric;
create index if not exists idx_market_candles_instrument_id_interval_time on market_candles (instrument_id, interval, bucket_start desc);

-- ---------------------------------------------------------------------------
-- 4. backfill_jobs — resumable, idempotent history loading
-- ---------------------------------------------------------------------------
create table if not exists backfill_jobs (
  id             uuid primary key default uuid_generate_v4(),
  instrument_key text not null,
  interval       candle_interval not null,
  from_date      date not null,
  to_date        date not null,
  source         data_source not null,
  status         text not null default 'pending',
  rows_written   integer not null default 0,
  attempts       integer not null default 0,
  last_error     text,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  constraint backfill_jobs_status_check check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  constraint backfill_jobs_range_check check (from_date <= to_date),
  constraint backfill_jobs_unique unique (instrument_key, interval, from_date, to_date)
);
create index if not exists idx_backfill_jobs_status on backfill_jobs (status) where status in ('pending', 'failed');
create index if not exists idx_backfill_jobs_instrument on backfill_jobs (instrument_key);
drop trigger if exists trg_backfill_jobs_updated_at on backfill_jobs;
create trigger trg_backfill_jobs_updated_at before update on backfill_jobs for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. RLS — service role bypasses RLS (the worker); authenticated users get read-only market data.
--    Anything user-scoped (watchlists, provider_accounts) is owner-only.
-- ---------------------------------------------------------------------------
alter table instruments       enable row level security;
alter table market_candles    enable row level security;
alter table instrument_status enable row level security;
alter table ws_failures       enable row level security;
alter table backfill_jobs     enable row level security;
alter table provider_accounts enable row level security;
alter table watchlists        enable row level security;

drop policy if exists instruments_read       on instruments;
drop policy if exists market_candles_read    on market_candles;
drop policy if exists instrument_status_read on instrument_status;
create policy instruments_read       on instruments       for select to authenticated using (true);
create policy market_candles_read    on market_candles    for select to authenticated using (true);
create policy instrument_status_read on instrument_status for select to authenticated using (true);

drop policy if exists watchlists_owner        on watchlists;
drop policy if exists provider_accounts_owner on provider_accounts;
create policy watchlists_owner        on watchlists        for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy provider_accounts_owner on provider_accounts for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());