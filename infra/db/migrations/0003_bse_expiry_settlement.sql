-- infra/db/migrations/0003_bse_expiry_settlement.sql — correct BSE option closes on expiry day.
--
-- Found 2026-10-14: for BSE options (SENSEX, BANKEX, ...) the expiry-day daily candle from Upstox
-- carries the UNDERLYING's final settlement value in `close` (e.g. 75,398.72 for an option that
-- traded between 0.05 and 1.85). 12,782 rows, all BSE CE/PE on their own expiry day, close within
-- 1% of the index close. NSE options and all futures are unaffected.
--
-- An option settles at intrinsic value against exactly that number, so:
--   CE close = max(0, S − strike)    PE close = max(0, strike − S)    S = the reported close
-- The provider's original value is kept in the new `close_reported` column (null = untouched), so
-- every correction is visible and reversible:  update market_candles set close = close_reported,
-- close_reported = null where close_reported is not null;
--
-- Same rule as settleBseExpiryClose() in apps/ingest-worker/src/jobs/backfill-history.ts, which
-- applies it to newly fetched candles. Keep the two in sync.
-- Note: a settled close can legitimately sit outside the day's traded range (e.g. 0 when the low
-- was 0.05) — exclude `close_reported is not null` rows from OHLC sanity checks.

alter table market_candles add column close_reported numeric;
comment on column market_candles.close_reported is
  'Provider''s original close when close was corrected (see migration 0003). Null = close is as reported.';

update market_candles c
set close_reported = c.close,
    close = round(case i.option_type
                    when 'CE' then greatest(0, c.close - i.strike)
                    else greatest(0, i.strike - c.close)
                  end, 2)
from instruments i
where i.id = c.instrument_id
  and i.segment = 'BSE_FO'
  and i.option_type in ('CE', 'PE')
  and i.strike > 0
  and c.interval = '1d'
  and (c.bucket_start at time zone 'Asia/Kolkata')::date = i.expiry
  and c.close > c.high
  and c.close between i.strike * 0.5 and i.strike * 2
  and c.close_reported is null;
