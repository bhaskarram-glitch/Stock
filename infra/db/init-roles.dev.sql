-- infra/db/init-roles.dev.sql — DEV ONLY. Runs once when the dev container's data volume is empty.
-- Mirrors the production role setup (Phase H3) with throwaway passwords.
-- Production roles are created by hand on the server with random passwords; never reuse these.

create role stock_migrator login password 'dev_migrator';
create role stock_app      login password 'dev_app';
create database stock owner stock_migrator;

\connect stock
revoke all on schema public from public;
grant usage on schema public to stock_app;
alter default privileges for role stock_migrator in schema public
  grant select, insert, update, delete on tables to stock_app;
alter default privileges for role stock_migrator in schema public
  grant usage, select on sequences to stock_app;
