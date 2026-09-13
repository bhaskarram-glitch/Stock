-- 0003_drop_legacy.sql — removes tables from the pre-Phase-0 design that nothing writes to.
-- APPLY ONLY AFTER confirming all three counts are 0:
--   select (select count(*) from market_snapshots) as snapshots,
--          (select count(*) from candles_1m)       as candles_1m,
--          (select count(*) from market_ticks)     as ticks;
-- If any count is non-zero, stop and decide whether that data matters before dropping.

drop table if exists market_snapshots;
drop table if exists candles_1m;
drop table if exists market_ticks;
drop sequence if exists market_ticks_id_seq;