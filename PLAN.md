# PLAN.md — F&O Historical Data → Trading Decision Platform

Legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[?n]` blocked on Open Decision n
Rules: no commit until Phase 0 is complete. GitHub Issues become the tracker after the first commit.
Direction: index F&O daily history first → live streaming (Phase 3) → analysis (Phase 4) → trading.
Decided 2026-09-11: Upstox Plus stays on; multiple Upstox Plus accounts allowed (one token per role).
Decided 2026-10-16: live streaming (now Phase 3) goes online before analysis (now Phase 4); analysis priorities are re-planned after streaming is live.
Decided 2026-09-27: host on an Oracle Cloud Always Free VM (prod) with self-hosted Postgres 17 — Supabase and Render are retired once Phase H is done. Laptop (Windows) = dev. Raspberry Pi / own machine possible later.

## How to work on this repo (for any agent picking this up)

- READ.md = what the repo is and was (audited 2026-09-08). PLAN.md = where it's going and what's done. Both live in the repo root AND in the Claude Project files; when PLAN.md changes, the user re-uploads it to the Project.
- The agent proposes changes as full files; the user applies them and reports `tsc`/`vitest` results. The agent flags any plan deviation and asks for PLAN.md to be updated.
- Style: to the point, options with consequences, explanations only when asked.

## Repo layout conventions (every new file gets an explicit path)

- `apps/ingest-worker/src/providers/<vendor>/` — vendor API clients, WS clients, decoders, vendor payload types (`upstox/`, later `kite/`, `groww/`)
- `apps/ingest-worker/src/services/` — provider-agnostic domain logic (aggregation, health, volume tracking)
- `apps/ingest-worker/src/lib/` — cross-cutting: logger, `db.ts` (pg pool + `upsertRows`), `db-types.ts` (row shapes), config helpers
- `apps/ingest-worker/src/test-utils/` — test doubles (e.g. `fake-db.ts`); excluded from the build
- `apps/ingest-worker/src/jobs/` — one-off / scheduled entry points (instrument sync, backfill, nightly append)
- `infra/db/migrations/NNNN_name.sql` — schema as code, applied by `npm run db:migrate`; never edit an applied file, add a new one
- `infra/db/` — Postgres compose (`compose.prod.yml` → server `/opt/stock-db/compose.yml`, `compose.dev.yml` for the laptop)
- `infra/docker/` — app Dockerfile (+ `Dockerfile.dockerignore`) + compose (worker and jobs)
- `infra/supabase/` — legacy Supabase migrations, kept only until the data move (H6) is verified, then deleted
- `packages/shared/` — types shared across apps only
- Tests colocated: `<file>.test.ts` next to the file. Live/integration tests: `<file>.smoke.test.ts`
- Docs: `READ.md` + `PLAN.md` at repo root only. No other README/ARCHITECTURE files.

## Cross-cutting constraints (apply to every phase)

- Portable: Dockerfile + docker-compose, all config via env, no Render-specific features, plain SQL migrations. Migration = copy `.env` + `docker compose up`.
- Account registry: numbered `UPSTOX_ACCOUNT_<n>_*` vars (or `UPSTOX_ACCOUNTS` JSON); roles `hist`, `ws`, `trade`; provider calls take an account handle, never a global token.
- Database: `DATABASE_URL` = `stock_app` (data read/write only); `MIGRATION_DATABASE_URL` = `stock_migrator` (schema owner, migrations only).
- Every job idempotent + resumable (upsert on unique keys, progress table).

---

## Phase 0 — Fix, clean, then commit

### 0.1 Data correctness (verified 2026-09-13: tsc clean, 32/32 tests)

- [x] Volume: feed emits cumulative `vtt` only; `CumulativeVolumeTracker` yields deltas, rollover-safe (Bug #1) + tests
- [x] Periodic bucket flusher `startFlusher()` in aggregator (Bug #5)
- [x] Late ticks for closed buckets dropped + counted (Bug #13)
- [x] Price must be finite and > 0 (`??`, explicit checks) in websocket-manager (Bug #14); mapper.ts not fixed — deleted in 0.3 with the legacy trio
- [x] 1d buckets aligned to IST midnight (new)
- [x] Pulled forward from live streaming (now Phase 3): sync in-memory update + serial batched upsert queue (Perf #2), `preloadInstrumentIds` fail-fast (Perf #3), injected Supabase client (Perf #4)

### 0.2 Small bugs (verified 2026-09-13: 38/38 tests)

- [x] Perf #1 pulled forward: `last_ws_ts` buffered, flushed per health-check cycle; HealthMonitor accepts injected Supabase client (Perf #4)
- [x] `WebSocketManager.stop()` ordering + HealthMonitor `stopped` flag (Bug #11)
- [x] Default URL: `DEFAULT_UPSTOX_BASE_URL` in client.ts + config.ts (Bug #15)
- [x] Retry exactly `maxRetries` attempts, injectable (Bug #16)
- [x] `dotenv.config()` out of websocket-manager.ts (Bug #17)

### 0.3 Cleanup (verified 2026-09-13: tsc clean, 38/38 tests, sync:instruments 120,523 rows / 0 failed)

- [x] Delete legacy trio candleBuilder / instrumentResolver / snapshotWriter + mapper.ts + `upstox-quote`, `snapshot-smoke` modes; index.ts rewritten with `healthcheck` (real DB check) + `websocket-stream` (Bug #10)
- [x] Single `CandleInterval` + `CandleSource` in `packages/shared/market/types.ts`; aggregator imports type from `@shared` (Bug #9)
- [x] Delete stale `dist/`, `coverage/`, `.npm-cache/`; new root `.gitignore` covers them
- [x] Remove `raw: feed` from ticks (Perf #6)
- [x] `sync-instruments-upstox.js` → `src/jobs/sync-instruments.ts` (TS, shared logger/client, `complete` source by default, F&O fields into `metadata` until Phase 1 columns); delete `sync-instruments-local.ts`, `cleanup-instruments.ts`, `examples/`
- [ ] Delete stray junk file `apps/ingest-worker/{console.error(err)`; delete `packages/shared/market/types.js` (compiled artifact)
- [ ] Delete `WEBSOCKET_README.md`, `WEBSOCKET_SYSTEM_README.md`, `ARCHITECTURE.md`, `apps/ingest-worker/README.md`
- [ ] Docs: keep READ.md + PLAN.md; fix or delete root/worker READMEs (Bug #18)

### 0.4 Verify + commit

- [x] `tsc --noEmit` clean, all tests pass (38/38)
- [ ] Initial commit + push — NEXT
- [ ] Create GitHub Issues from remaining PLAN items (tracker switch)

---

## Phase 1 — Schema for F&O (COMPLETE 2026-09-13: 44/44 tests)

- [x] Live schema captured; extra legacy tables found: `candles_1m`, `market_ticks`, `provider_accounts`, `watchlists`
- [x] `infra/supabase/migrations/0001_baseline.sql` — idempotent capture of the live schema (enums, tables, indexes, guarded FK, updated_at triggers)
- [x] `0002_fno.sql` — `instruments` gains `underlying_key`, `underlying_symbol`, `expiry` (date, IST), `strike`, `option_type` (CE/PE), `weekly`, `is_expired` + backfill from metadata; `market_candles.oi`; enum values `1h`,`1d`,`hist`,`hist_expired`; `backfill_jobs`; RLS (authenticated read-only on market data, owner-only on user tables)
- [x] `0003_drop_legacy.sql` — legacy tables dropped
- [x] Regenerate `database.types.ts` via `supabase gen types` (CLI login via personal access token from the correct account)
- [x] `sync-instruments.ts` writes the new typed columns (120,523 rows re-synced)
- [x] Decisions: keep `ws_failures` (write to it in Phase 3, live streaming), keep `watchlists`/`provider_accounts` (future API/web; worker tokens stay in env)
- [x] `infra/docker/Dockerfile` + `docker-compose.yml` + `.dockerignore`; `.env.example` rewritten
- [x] `UPSTOX_ACCOUNTS` registry in `config.ts` (roles ws/hist/trade, `plus` flag, legacy single-token fallback) + `config.test.ts`; `WORKER_MODE` now validated (unknown → throws)

## Phase 2 — F&O daily historical backfill (started 2026-09-13)

Verified API facts (probe round 1, 2026-09-13): expired key = `NSE_FO|<token>|DD-MM-YYYY`; candle rows `[ts,o,h,l,c,vol,oi]`; Plus is active.
**Options/futures history floor is 2024-10-03** — NIFTY expiries returns 102 dates from 2024-10-03 to 2026-09-08, and every 2022 contract request returns 0 rows. Index SPOT daily reaches at least 2010.
Scope — spot daily for ALL NSE/BSE indices; F&O daily for the 9 derivative indices:
NSE — Nifty 50 (NIFTY), Nifty Bank (BANKNIFTY), Nifty Financial Services (FINNIFTY), Nifty Midcap Select (MIDCPNIFTY), Nifty Next 50 (NIFTYNXT50), Nifty India FPI 150 (NIFTYFPI);
BSE — SENSEX, BANKEX, BSE Focused IT (BSEFIT).

### 2.0 Probe (decision gate)

- [x] Upstox Plus on; Analytics Token in `.env`
- [~] `providers/upstox/historical.ts` — read-only client: historical V3, expiries, expired option/future contracts, expired candles; throttled; typed errors (429 / Plus)
- [~] `jobs/probe-history.ts` — verifies 2022 reach for index daily, expired contracts, expired candles; measures zero-activity share
- [x] Expiry-date source resolved: Get Expiries covers 2024-10 → today (102 dates for NIFTY); DB rows from old syncs only span 2026-04→2026-06, so Get Expiries is the source. No pre-2024-10 option history exists via Upstox.
- [x] Probe round 2 (2026-09-14): expired candles work; ~13.9 rows/contract, **0% dead rows**, 100% carry OI, 86 ms/request → NIFTY all 102 expiries ≈ 20,196 contracts / **281,734 rows / ~0.5 h**
- [x] Storage: no row-skipping needed; all 9 indices project to low millions of rows — stay on Supabase free, migrate to the Oracle VM if it tightens `[open 2 closed]`

### 2.1 Underlyings

- [ ] Index spot daily for all NSE/BSE indices, 2022-01-01 → today (Historical V3; could start earlier — spot reaches 2010+)
- [ ] Index futures daily (active via V3, expired via expired API)

### 2.2 Backfill runner

- [~] `0004_backfill_state.sql` — `backfill_state` watermarks (replaces unused `backfill_jobs`) + `underlying_expiries`
- [~] `providers/upstox/indices.ts` — the 9 F&O underlyings, resolved from `instruments` by name (+ tests)
- [~] `jobs/backfill-history.ts` — targets `spot | options | futures | all`; flags `--symbols --from --limit --dry-run`
- Incremental rules: expired contracts marked `is_final` and never re-fetched; everything else resumes at `last_date + 1`; enumerated expiries recorded in `underlying_expiries`
- Daily candles normalised to IST midnight so historical 1d matches the live aggregator's 1d
- [x] Rate limits confirmed from docs: **25/s, 250/min, 1000/30 min, per API per user**. The 30-min window binds: ~2,000 requests/hour/account → NIFTY (20k contracts) ≈ 10 h on one account.
- [x] `providers/upstox/rate-limiter.ts` — sliding-window limiter for all three windows, 0.9 safety factor, `penalise()` on 429 (+ tests)
- [x] Duplicate candles falling in one IST day are merged before upsert (Postgres rejects a batch touching one conflict key twice)
- [~] Multi-account (2026-09-26): 5 Upstox Plus accounts, each a different user with its own API app
  - `config.ts` — numbered vars `UPSTOX_ACCOUNT_<n>_TOKEN/_ALIAS/_ROLES/_PLUS` (default roles `hist,ws`); precedence JSON → numbered → legacy, never merged; duplicate alias or reused token rejected at startup; `describeAccount()` logs a 6-char fingerprint only
  - `historical.ts` — one limiter per **endpoint family** (`historical-candles`, `expiries`, `contracts`, `expired-candles`) per account; 429 pauses only that account+family
  - `UpstoxHistoricalClientPool` exposes the API directly and routes each call to the account that can send soonest for that family; the job loop still assigns work one item at a time, so no duplicates
  - `index.ts` streams with `upstoxAccounts.require("ws")`; deprecated `upstoxAccessToken` removed
  - `jobs/check-accounts.ts` (`npm run accounts:check`) — one call per account + one Plus check, exit 1 on any failure
- [ ] All 5 tokens in `.env`, `accounts:check` green
- [ ] Run NIFTY options, then the rest; report actual rows + DB size

### 2.3 Ongoing

- [ ] Nightly job: append yesterday's daily candles for active contracts; mark expired; mark instruments absent from master inactive; refresh `underlying_key` on old rows
- [ ] Data QA: gap detection, OI sanity

## Phase H — Hosting on Oracle VM + self-hosted Postgres (started 2026-09-27)

Prod = `stock-prod-01`, Oracle Cloud ap-mumbai-1, Ampere A1.Flex 4 OCPU / 24 GB, Ubuntu 24.04 Minimal aarch64, 50 GB boot + 150 GB data volume at `/data`.
Access = Tailscale only (`ssh stock-prod`); no public inbound ports.

- [x] H1 — VM created (after "out of host capacity" retries via Resource Manager stack), renamed, SSH key login, ₹1 budget alert, Oracle-managed encryption, agent plugins, 150 GB block volume attached
- [x] H2 — hardening: auto security updates (reboot 02:30 IST), Asia/Kolkata + chrony on Oracle NTP, 2 GB swap, Tailscale (key expiry off, MagicDNS), SSH keys-only/no root, fail2ban, public port 22 closed, weekly boot-volume backup policy (3 kept)
- [x] H3 — `/data` (ext4, nofail, by UUID); Docker with log caps and `RequiresMountsFor=/data`; Postgres 17 container `stock-pg` on 127.0.0.1:5432 (`/opt/stock-db`); DB `stock`, roles `stock_migrator` + `stock_app`; laptop access via `stockdb` PowerShell shortcut (psql on the server). Password login + reboot test passed (2026-10-12)
- [x] H4 — repo off Supabase (2026-10-09; pushed 2026-10-12 as `6f063a7`, 76 passed / 5 skipped):
  - `supabase-js` → `pg`; `src/lib/db.ts` (pool, DATE as string, `upsertRows` with chunking + in-batch dedupe), `src/lib/db-types.ts`
  - `infra/db/migrations/0001_init.sql` — consolidated schema (gen_random_uuid, no RLS, live `provider` enum, redundant indexes dropped)
  - `src/jobs/migrate.ts` (`npm run db:migrate`, `db:status`) — once-only, per-file transaction, advisory lock, checksum guard
  - Config: `DATABASE_URL` / `MIGRATION_DATABASE_URL` replace `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
  - Docker: migrations in image; compose jobs `migrate`, `sync-instruments`, `backfill`, `check-accounts`; worker joins `stock-net`, DB host `stock-pg`; `.dockerignore` fixed (was never applied)
  - `infra/db/compose.prod.yml`, `compose.dev.yml`, `init-roles.dev.sql`
  - Deleted: `lib/supabase.ts`, `lib/database.types.ts`, `schema-websocket.sql`
  - Integration test `src/lib/db.integration.test.ts` (runs when `TEST_DATABASE_URL` is set)
- [ ] H5 — laptop dev: WSL2 Ubuntu + Docker Desktop + Node; `compose.dev.yml`; deferred until needed (decided 2026-10-08: nothing installed on the laptop yet)
- [x] H6 — data move (2026-10-12)
  - [x] Repo cloned to `/opt/stock`; `/opt/stock-db/compose.yml` replaced with `infra/db/compose.prod.yml` (adds `stock-net`); worker `.env` (DB URLs only, 600); image built on arm64; `migrate` applied `0001_init.sql`; healthcheck OK
  - [x] Live Supabase schema exported (`/data/backups/supabase/supabase_schema.sql`) and compared on Postgres (2026-10-12): all 82 columns, all constraints and all enums used by tables identical to `0001_init.sql`. Live-only leftovers not carried over: unused `market_provider` enum, `update_updated_at_column()` + 2 duplicate updated_at triggers, 5 redundant indexes, RLS policies
  - [x] `pg_dump --data-only` (13 MB, `/data/backups/supabase/supabase_data.dump`) → `pg_restore --single-transaction` into `stock`; exact counts match on all 8 tables (instruments 214,316 · market_candles 57,725 · backfill_state 3,068 · underlying_expiries 159 · instrument_status 3); 0 orphan candles; DB 116 MB
  - [ ] Keep Supabase untouched until 2026-10-19 as fallback, then pause/delete it; delete `infra/supabase/` and both dump files
- [~] H7 — scheduled operation (code delivered 2026-10-12)
  - Fix: backfill watermark = date of the newest candle received, not "today" (a run before Upstox published today's candle skipped that day forever); contracts final only after expiry day; `0002_fix_backfill_watermarks.sql` repairs existing rows; backfill job importable for tests (+ `backfill-history.test.ts`)
  - `infra/ops/` — `install.sh` (idempotent, `STOCK_USER` for a Pi), `stock.env.example` → `/etc/stock/stock.env`, `bin/` scripts → `/usr/local/bin`, `systemd/` units
  - Schedule (IST): `check-accounts` Mon–Fri 07:30 · `sync-instruments` Mon–Fri 08:00 · `backfill all` Mon–Fri 19:30 · `backup` daily 01:30 · health check every 15 min · status message daily 21:30 · restore test first Sunday 04:00
  - Any failed job → Telegram with the log tail (`stock-notify-failure@`); health alerts only on change; daily status doubles as a dead-man's switch; same job can't run twice at once (`flock`)
  - Backups: `pg_dump -Fc` verified readable, 7 days local in `/data/backups/daily`; off-server copy via rclone when `RCLONE_REMOTE` set (H7 part 2)
  - Updates: `stock-deploy` (fast-forward, build, migrate, restart worker if running)
  - [x] Deployed 2026-10-13: patch pushed (`e631e6f`), `install.sh` run, 5 Upstox accounts in server `.env`, `check-accounts` green (Plus now verified on every hist account, `219f89b`), Telegram alerts working, first backup + restore test passed
  - [x] Clean refetch 2026-10-13/14: all market data wiped (schema kept) and re-fetched with the fixed code — 693 min, 106,857 contracts, 1,218,656 candles (spot 4,225 · expired contracts 1,214,431), 0 errors, all 369 expiries fully loaded, DB 534 MB
  - [x] Data QA 2026-10-14: 12,782 BSE option candles on their own expiry day carried the INDEX level as `close` (source data error). Fixed: `close` = settlement value (CE max(0, S−K), PE max(0, K−S), S = reported value), original kept in new `market_candles.close_reported` — `0003_bse_expiry_settlement.sql` for existing rows, `settleBseExpiryClose()` in `backfill-history.ts` for new ones. NSE options and all futures unaffected
  - [x] Part 2 (2026-10-14): off-server backups — Object Storage bucket `stock-backups` (private), dynamic group `Default/stock-vm` + policy `stock-vm-backups` (that bucket only), official rclone .deb (Ubuntu's build lacks the Oracle backend) with instance-principal auth (no keys on the server), `RCLONE_REMOTE=oci:stock-backups/daily`, 30 days kept; a cloud copy restored successfully. Backup ≈ 65 MB/day
  - Streaming worker NOT started: needs Phase 3 (live streaming) first (market calendar, reconnect exhaustion, heartbeat)
- [~] Data gaps (code delivered 2026-10-14)
  - New backfill target `active` (in `all`, runs last): still-trading futures + options of the 9 indices (~10.6k contracts) via Historical V3, ~1–1.5 h per evening on 5 accounts
  - One key per contract for life: candles + watermarks use the expired-style key `<segment>|<token>|<DD-MM-YYYY>` from day one (`canonicalContractKey`), so active and post-expiry history form one series; the expired run resumes from the active run's watermark. Verified 2026-10-14: trading key = `segment|token` for 42,776/42,776, expired key format for 107,288/107,288
  - Spot now covers every index in the instrument master (218: NSE 139, BSE 79), or only `--symbols` when given
  - Log line `Waiting for Upstox rate limit` whenever every account must wait ≥ 30 s
  - [x] First run 2026-10-15: spot for 214/218 indices, 3,543 still-trading contracts with history (far-dated ones not traded yet), 187,969 `hist` + 1,217,078 `hist_expired` candles
  - Unsupported keys (2026-10-16): Upstox lists `NSE_INDEX|BHARATBOND-APR30..33` in its master file but rejects them on both history endpoints (UDAPI1021) and on live quotes — verified, not our key handling. Such keys are now recorded once (`backfill_state.is_final` + `skip_reason`, migration `0004_backfill_skip_reason.sql`) and skipped instead of counting as nightly errors; the daily status shows "skipped keys"
  - Phase 3 note: live WS subscribes with trading keys; persisted live candles must be written under the permanent key (`instruments.metadata.trading_key` maps them)
- [x] H8 — setup & operations document delivered 2026-10-16 as a Claude Doc ("Stock Platform — Setup & Operations"); memory updated. Phase H COMPLETE except Supabase retirement on 2026-10-19

## Phase 3 — Live streaming, unattended (was Phase 4; moved ahead of analysis 2026-10-16)

- [ ] Worker auth via Analytics Token from account registry (WS role accounts)
- [ ] Persist 1h candles only (aggregate 1m→1h in memory); 1m/5m optional later
- [ ] Exit non-zero on reconnect exhaustion or capped infinite backoff (Bug #8)
- [ ] Real heartbeat: pong timeout + `heartbeat_ts` (Bug #12)
- [ ] Market calendar: `/v2/market/holidays`, `/v2/market/timings`, WS `market_info`
- [ ] Telegram alerts: worker death, auth failure, backfill failures, data gaps
- [x] Host: Oracle VM via docker compose (Phase H)
- [ ] Performance: debug-level tick logs (Perf #5) — Perf #1/#2/#3/#4 done in Phase 0
- [ ] Shard keys across connections and across accounts (5 conn/account on Plus)
- [ ] Use Upstox `I1` 1m OHLC from full-mode feed if present for F&O; roll up 5m/15m locally
- [ ] API fallback persists candles with `source: 'api'` (Bug #6)
- [ ] EOD reconciliation: live candles vs intraday API

---

## Phase 4 — Analysis foundation (was Phase 3; priorities re-planned once live streaming is online)

- [ ] Derived daily tables: option chain snapshot per (underlying, expiry, date) — PCR, max pain, OI change, IV (computed locally)
- [ ] Indicator layer over stored candles
- [ ] Backtest harness with realistic F&O costs (₹30/order Plus brokerage, STT, exchange fees, slippage)
- [ ] Trade journal: for every live/paper pick record thesis → outcome → post-mortem (the "why did it fail/succeed" loop)

---

## Phase 5 — Intraday F&O data

- [ ] Backfill 1m/5m/15m for chosen underlyings (minutes from 2022; expired via Plus API)
- [ ] Intraday strategy backtests + paper trading via trade journal

---

## Phase 6 — API + Web

- [ ] Root `package.json` + npm workspaces
- [ ] `apps/api` read-only (candles, chain snapshots, journal)
- [ ] `apps/web` dashboard; auth for self + limited accounts

---

## Phase 7 — Trading execution (after Phase 4/5 show an edge)

- [ ] Daily OAuth automation (Access Token Request API, approve via app/WhatsApp)
- [ ] Order placement (intraday + F&O), positions, risk limits, kill switch
- [ ] Multi-provider decision (Groww/Kite)

---

## Open decisions

1. RESOLVED — expiries come from Get Expiries (2024-10 onwards); no earlier option history is available from Upstox
2. RESOLVED — measured cost is far lower than estimated (NIFTY ≈ 282k rows); Supabase free for now, Oracle VM later
3. RESOLVED 2026-09-27 — Oracle Free VM (Mumbai, Ampere A1 4 OCPU / 24 GB) is prod; self-hosted Postgres replaces Supabase
4. Render free tier has no free background workers (to verify at deploy) — nightly backfill via GitHub Actions until then

## Verified facts (2026-09-10)

- Analytics Token: free, 1-yr, read-only; covers Market Data Feed V3, Historical V3, quotes, market status, option chain. Not orders.
- OAuth access token expires 3:30 AM daily — only needed for trading.
- WS limits: 2 connections/user (5 on Plus); `full` 2,000 keys/conn, `ltpc` 5,000; `ltpc` has no volume.
- Historical V3: minutes/hours from Jan 2022, day/week/month from 2000. Candles = OHLCV (+OI for F&O). No depth.
- Expired-instruments candle API (1m…30m, day, with OI) requires Upstox Plus.
- Upstox Plus: no monthly fee currently; brokerage ₹20 → ₹30/order; 24h cooling-off on switch; may become chargeable with notice.
- Holidays/timings/status: `/v2/market/holidays`, `/v2/market/timings/{date}`, `/v2/market/status/{exchange}`.
