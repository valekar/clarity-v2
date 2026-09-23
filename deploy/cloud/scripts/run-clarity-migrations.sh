#!/bin/sh
set -eu

node --experimental-strip-types /app/src/migrate.ts
psql --no-psqlrc --set ON_ERROR_STOP=1 --file /app/grant-clarity-runtime.sql
