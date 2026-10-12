-- infra/db/migrations/0002_fix_backfill_watermarks.sql — one-time data repair (2026-10-12).
-- Before the fix in jobs/backfill-history.ts, a spot run recorded "today" as loaded even when Upstox
-- had not yet published today's daily candle (run during market hours or soon after close), so that
-- day would never have been fetched. Pull every non-final daily watermark back to the newest candle
-- actually stored. The next backfill re-fetches from there; candle writes are upserts, so re-fetching
-- a day that is already present is harmless.
update backfill_state b
set last_date = c.last_candle
from (
  select instrument_key, max((bucket_start at time zone 'Asia/Kolkata')::date) as last_candle
  from market_candles
  where interval = '1d'
  group by instrument_key
) c
where b.interval = '1d'
  and not b.is_final
  and b.instrument_key = c.instrument_key
  and b.last_date > c.last_candle;
