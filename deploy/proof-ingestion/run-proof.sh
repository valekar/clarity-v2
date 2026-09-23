#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose --project-name clarity-v2-p0-4 --file compose.yaml)
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans --timeout 10
  rm -rf .runtime
}
trap cleanup EXIT INT TERM

mkdir -p .runtime
"${compose[@]}" down --volumes --remove-orphans --timeout 10
"${compose[@]}" build --pull=false proof
"${compose[@]}" up --detach --pull never minio minio-init source cloud
"${compose[@]}" run --rm --no-deps proof baseline

"${compose[@]}" stop source
"${compose[@]}" rm --force source
docker volume rm clarity-v2-p0-4-source-db
"${compose[@]}" up --detach --no-deps source
"${compose[@]}" run --rm --no-deps proof source-reset
"${compose[@]}" run --rm --no-deps proof benchmark
cp .runtime/result.json results.json
