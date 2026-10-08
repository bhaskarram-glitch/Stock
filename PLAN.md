# PLAN.md — F&O Historical Data → Trading Decision Platform

Legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[?n]` blocked on Open Decision n
Rules: no commit until Phase 0 is complete. GitHub Issues become the tracker after the first commit.
Direction: index F&O daily history (from 2022-01-01) first → live WS for indexes stored at 1h → analysis → trading.
Decided 2026-09-11: Upstox Plus stays on; multiple Upstox Plus accounts allowed (one token per role); Render + Supabase now, migrate to Oracle Free VM later with zero-friction.

## How to work on this repo (for any agent picking this up)

- READ.md = what the repo is and was (audited 2026-09-08). PLAN.md = where it's going and what's done. Both live in the repo root AND in the Claude Project files; when PLAN.md changes, the user re-uploads it to the Project.
- The agent proposes changes as full files; the user applies them and reports `tsc`/`vitest` results. The agent flags any plan deviation and asks for PLAN.md to be updated.
- Style: to the point, options with consequences, explanations only when asked.

## Repo layout conventions (every new file gets an explicit path)

- `apps/ingest-worker/src/providers/<vendor>/` — vendor API clients, WS clients, decoders, vendor payload types (`upstox/`, later `kite/`, `groww/`)
- `apps/ingest-worker/src/services/` — provider-agnostic domain logic (aggregation, health, volume tracking)
- `apps/ingest-worker/src/lib/` — cross-cutting: logger, Supabase client, DB types, config helpers
- `apps/ingest-worker/src/jobs/` — one-off / scheduled entry points (instrument sync, backfill, nightly append)
- `infra/supabase/migrations/NNNN_name.sql` — schema as code; `infra/docker/` — Dockerfile + compose
- `packages/shared/` — types shared across apps only
- Tests colocated: `<file>.test.ts` next to the file. Live/integration tests: `<file>.smoke.test.ts`
- Docs: `READ.md` + `PLAN.md` at repo root only. No other README/ARCHITECTURE files.

## Cross-cutting constraints (apply to every phase)

- Portable: Dockerfile + docker-compose, all config via env, no Render-specific features, plain SQL migrations. Migration = copy `.env` + `docker compose up`.
- Account registry: `UPSTOX_ACCOUNTS` JSON (alias → token, roles: `hist`, `ws-1`, `ws-2`, `trade`); provider calls take an account handle, never a global token.
- Every job idempotent + resumable (upsert on unique keys, progress table).

---

## Phase 0 — Fix, clean, then commit

### 0.1 Data correctness (verified 2026-09-13: tsc clean, 32/32 tests)

- [x] Volume: feed emits cumulative `vtt` only; `CumulativeVolumeTracker` yields deltas, rollover-safe (Bug #1) + tests
- [x] Periodic bucket flusher `startFlusher()` in aggregator (Bug #5)
- [x] Late ticks for closed buckets dropped + counted (Bug #13)
- [x] Price must be finite and > 0 (`??`, explicit checks) in websocket-manager (Bug #14); mapper.ts not fixed — deleted in 0.3 with the legacy trio
- [x] 1d buckets aligned to IST midnight (new)
- [x] Pulled forward from Phase 4: sync in-memory update + serial batched upsert queue (Perf #2), `preloadInstrumentIds` fail-fast (Perf #3), injected Supabase client (Perf #4)

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
- [x] Decisions: keep `ws_failures` (write to it in Phase 4), keep `watchlists`/`provider_accounts` (future API/web; worker tokens stay in env)
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

## Phase 3 — Analysis foundation

- [ ] Derived daily tables: option chain snapshot per (underlying, expiry, date) — PCR, max pain, OI change, IV (computed locally)
- [ ] Indicator layer over stored candles
- [ ] Backtest harness with realistic F&O costs (₹30/order Plus brokerage, STT, exchange fees, slippage)
- [ ] Trade journal: for every live/paper pick record thesis → outcome → post-mortem (the "why did it fail/succeed" loop)

---

## Phase 4 — Live streaming for indexes, unattended

- [ ] Worker auth via Analytics Token from account registry (WS role accounts)
- [ ] Persist 1h candles only (aggregate 1m→1h in memory); 1m/5m optional later
- [ ] Exit non-zero on reconnect exhaustion or capped infinite backoff (Bug #8)
- [ ] Real heartbeat: pong timeout + `heartbeat_ts` (Bug #12)
- [ ] Market calendar: `/v2/market/holidays`, `/v2/market/timings`, WS `market_info`
- [ ] Telegram alerts: worker death, auth failure, backfill failures, data gaps
- [ ] Host: Render (paid worker) or VM when available; docker-compose either way
- [ ] Performance: debug-level tick logs (Perf #5) — Perf #1/#2/#3/#4 done in Phase 0
- [ ] Shard keys across connections and across accounts (5 conn/account on Plus)
- [ ] Use Upstox `I1` 1m OHLC from full-mode feed if present for F&O; roll up 5m/15m locally
- [ ] API fallback persists candles with `source: 'api'` (Bug #6)
- [ ] EOD reconciliation: live candles vs intraday API

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

## Phase 7 — Trading execution (after Phase 3/5 show an edge)

- [ ] Daily OAuth automation (Access Token Request API, approve via app/WhatsApp)
- [ ] Order placement (intraday + F&O), positions, risk limits, kill switch
- [ ] Multi-provider decision (Groww/Kite)

---

## Open decisions

1. RESOLVED — expiries come from Get Expiries (2024-10 onwards); no earlier option history is available from Upstox
2. RESOLVED — measured cost is far lower than estimated (NIFTY ≈ 282k rows); Supabase free for now, Oracle VM later
3. Oracle Free VM — pending user
4. Render free tier has no free background workers (to verify at deploy) — nightly backfill via GitHub Actions until then

## Verified facts (2026-09-10)

- Analytics Token: free, 1-yr, read-only; covers Market Data Feed V3, Historical V3, quotes, market status, option chain. Not orders.
- OAuth access token expires 3:30 AM daily — only needed for trading.
- WS limits: 2 connections/user (5 on Plus); `full` 2,000 keys/conn, `ltpc` 5,000; `ltpc` has no volume.
- Historical V3: minutes/hours from Jan 2022, day/week/month from 2000. Candles = OHLCV (+OI for F&O). No depth.
- Expired-instruments candle API (1m…30m, day, with OI) requires Upstox Plus.
- Upstox Plus: no monthly fee currently; brokerage ₹20 → ₹30/order; 24h cooling-off on switch; may become chargeable with notice.
- Holidays/timings/status: `/v2/market/holidays`, `/v2/market/timings/{date}`, `/v2/market/status/{exchange}`.
