# Stock

## Structure

apps/

- ingest-worker - Node worker scaffold

packages/

- shared - shared market types
- tsconfig.base.json - shared TypeScript base config

infra/

- render
- supabase

## Current Status

This repo currently contains a single worker app under `apps/ingest-worker`.
The instrument sync script in `scripts/sync-instruments.ts` is not implemented yet
and intentionally exits with an actionable error instead of silently succeeding.
