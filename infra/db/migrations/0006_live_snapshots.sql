-- infra/db/migrations/0006_live_snapshots.sql — 5-minute market snapshots (Phase 3, 2026-10-22).
--
-- Candles only exist for minutes with a trade, so open interest, quotes and IV of strikes that did
-- not trade are lost. At every 5-minute mark (IST :00, :05, …) the live worker writes, for each
-- streamed instrument WHOSE STATE CHANGED since its previous snapshot (and for every instrument in
-- the first snapshot of the session), its latest LTP, cumulative volume, OI, best bid/ask, ATP, and
-- for options Upstox's IV and greeks.
--
-- Reading the chain "as of" time T: per sid, the latest row with ts <= T (same session):
--   select distinct on (sid) * from live_snapshots
--    where ts <= T and ts >= T::date-at-IST-midnight order by sid, ts desc;
--
-- Not re-fetchable from Upstox afterwards → kept permanently and included in the nightly backup.
-- Partitioned by IST month (live_snapshots_YYYYMM), created by ensure_live_partitions().

create table live_snapshots (
  sid       integer          not null,
  ts        timestamptz      not null,  -- the 5-minute mark
  ltp       double precision,
  ltt       timestamptz,                -- exchange time of the last trade
  volume    bigint,                     -- cumulative volume traded today (vtt)
  oi        bigint,
  atp       double precision,           -- average traded price today
  bid       double precision,
  bid_qty   integer,
  ask       double precision,
  ask_qty   integer,
  iv        real,
  delta     real,
  gamma     real,
  theta     real,
  vega      real,
  primary key (sid, ts)
) partition by range (ts);

comment on table live_snapshots is '5-min state per streamed instrument, written only when changed (first snapshot of a session: all); one partition per IST month (live_snapshots_YYYYMM); kept permanently';

create or replace function ensure_live_partitions(p_day date) returns void
language plpgsql security definer set search_path = public as $$
declare
  m date := date_trunc('month', p_day)::date;
begin
  execute format(
    'create table if not exists %I partition of live_candles_fine for values from (%L) to (%L)',
    'live_candles_fine_' || to_char(p_day, 'YYYYMMDD'),
    p_day::timestamp at time zone 'Asia/Kolkata',
    (p_day + 1)::timestamp at time zone 'Asia/Kolkata');
  execute format(
    'create table if not exists %I partition of live_candles for values from (%L) to (%L)',
    'live_candles_' || to_char(m, 'YYYYMM'),
    m::timestamp at time zone 'Asia/Kolkata',
    (m + interval '1 month')::timestamp at time zone 'Asia/Kolkata');
  execute format(
    'create table if not exists %I partition of live_snapshots for values from (%L) to (%L)',
    'live_snapshots_' || to_char(m, 'YYYYMM'),
    m::timestamp at time zone 'Asia/Kolkata',
    (m + interval '1 month')::timestamp at time zone 'Asia/Kolkata');
end $$;

revoke all on function ensure_live_partitions(date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'stock_app') then
    grant execute on function ensure_live_partitions(date) to stock_app;
    grant select, insert, update, delete on live_snapshots to stock_app;
  end if;
end $$;
