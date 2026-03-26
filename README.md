# Stock

## Structure

apps/

- web — Next.js SSR app
- api — Node API service
- ingest-worker — Node worker

packages/

- db — SQL migrations, types, queries
- market-core — provider adapters and schemas
- market-upstox — Upstox adapter
- market-groww — Groww adapter
- market-kite — Zerodha adapter
- shared — shared schemas, utils, constants

infra/

- render
- supabase
