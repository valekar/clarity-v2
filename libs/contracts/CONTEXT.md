# Contracts context

## Responsibility

`@clarity/contracts` owns browser-safe request and response types plus runtime validators shared by the web ingestion routes and the independent sync service.

## Inputs

The package receives untrusted JSON values from device lease, study admission, upload admission/completion/status, and observed manifest endpoints. Validators bound identifiers, versions, byte ranges, page sizes, metadata strings, and signed upload headers before callers rely on those values.

## Outputs

Exports are TypeScript DTOs and pure validation functions from `src/index.ts`. The sync service uses the same types to form lease-fenced requests; web routes may use validators without importing Node or privileged server modules.

## Boundary

This package must remain browser-safe. It may not import Node built-ins, database drivers, filesystem code, provider SDKs, Next.js, or Electron. Cryptographic hashing and persistence belong to server or service implementations, not this package.

## Validation

Run `pnpm --filter @clarity/contracts typecheck`, `pnpm --filter @clarity/contracts test`, and `pnpm --filter @clarity/contracts build` after changing a DTO or validator.
