-- infra/db/migrations/0004_backfill_skip_reason.sql — keys Upstox will never serve (2026-10-16).
--
-- Upstox lists NSE_INDEX|BHARATBOND-APR30..33 in its own instrument master, but both history
-- endpoints answer UDAPI1021 "Instrument key is of invalid format" and the live-quote API rejects
-- them too. Before this change they were retried every night and counted as backfill errors.
-- Now such a key is recorded once (is_final = true, reason in skip_reason, no last_error) and
-- skipped; markUnsupported() in apps/ingest-worker/src/jobs/backfill-history.ts does this for new
-- cases. To retry them later:
--   update backfill_state set is_final = false, skip_reason = null where skip_reason is not null;

alter table backfill_state add column skip_reason text;
comment on column backfill_state.skip_reason is
  'Why this key is permanently skipped (Upstox rejects it). Null = normal. Set together with is_final.';

update backfill_state
set is_final = true, skip_reason = last_error, last_error = null
where last_error like '%Instrument key is of invalid format%';
