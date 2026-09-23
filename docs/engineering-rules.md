# Clarity V2 engineering rules

## Scope and authority

- Follow root AGENTS.md and the user's latest scope. The first 23 September
  follow-up authorized the V2 scaffold; the later implementation request expands
  work across the active plan. The user selected synthetic integration for now.
  Real centre deployment, installed-service tests and external message delivery
  require their named inputs and acceptance evidence.
- V1 is read-only. Copy selected code only during authorized implementation after
  checking its callers, tests, source revision and license. Never move/delete V1.
- The operator owns Git mutations. No init, commit, push, checkout, stash or reset
  is authorized by this document. Read-only Git inspection is allowed.
- Do not send real messages, access additional patient data, register providers,
  install machine services or deploy as a side effect of writing a plan.
- User-selected V2 choices override V1's one-package and wiki conventions:
  TypeScript, pnpm workspaces, Turbo, apps/ plus libs/, Electron, Next.js, Hanko,
  one-centre staff authorization first and ICM memory without a wiki.

## Implementation discipline

- KISS, DRY and YAGNI. A monorepo is a build organization, not permission to add
  generic engines, Kubernetes, Redis, microservices or speculative packages.
- Pure domain functions own validation, decisions and state transitions; pass time,
  identity and randomness explicitly. Shells own network, files, database and UI I/O.
- Routes extract trusted identity and transport data; services orchestrate; typed
  repositories own SQL/transactions; adapters own provider integrations.
- Use intention-revealing names: Report, patient, referring doctor, DICOM study,
  source, ingestion, dispatch, recipient link and expiry. Define protocol names
  without renaming DICOM concepts. Name effects `load`, `save`, `upload` or `send`.
- TypeScript strict, noUncheckedIndexedAccess and exactOptionalPropertyTypes apply
  to apps, scripts, shared packages and tests. Validate unknown input at boundaries.
- Authored source, tests, SQL, scripts and executable configuration have a hard
  maximum of 700 physical lines. No minifying to pass. Reference prose is exempt.
- Use explicit package exports and workspace dependencies; no app-to-app imports,
  circular dependencies, all-purpose barrel or deep relative imports across packages.
- Keep browser, privileged desktop, device service and cloud dependencies distinct.
  UI packages cannot import PostgreSQL, OS credentials or storage admin SDKs.
- Pin compatible supported runtimes, package manager, dependency versions and image
  digests when scaffolding. One pnpm lockfile; frozen installs in CI and Docker.
- Handle promises, cancellation and shutdown. Bound file size, concurrency, queues,
  staging and response metadata. Stream clinical bytes; never buffer a full study.

## Data, identity and effects

- PostgreSQL owns cloud product metadata, SQLite owns local checkpoints/queue,
  Hanko owns authentication records and Orthanc owns its imaging index.
- Preserve primary/foreign keys, uniqueness, version checks and short transactions.
  Use separate migration/runtime roles and additive applied migrations.
- Never match patients by name or phone alone. Preserve source identifiers and
  source patient snapshots; ambiguous identities require an explicit resolution.
- Every staff API checks active account and permission. Hanko proves identity;
  application tables authorize actions. User-editable metadata cannot grant access.
- Machine credentials are independent of staff sessions, limited to one source,
  protected for the service identity and revocable. No broad bucket keys on devices.
- Persist job intent before external effects. Assume at-least-once delivery;
  deduplicate and reconcile uncertain uploads and provider sends.
- Link expiry is separate from file retention. No automatic source deletion,
  clinical-file purge, archive migration or cleanup copied from the client app.
- Keep secrets, tokens and patient details out of logs, fixtures, map cards, Turbo
  caches and documentation. Use synthetic fixtures; ignore patterns do not sanitize.

## Desktop, cloud and verification

- Desktop renderer stays sandboxed/context-isolated with Node integration off.
  Expose narrow validated IPC operations, verify sender/origin and block unapproved
  navigation. Remote dashboard content gets no general filesystem/network bridge.
- A system service owns sync independently of Electron and user login. Use a
  constrained service account and local IPC ACLs; elevate installer steps only.
- Clinical staff UI must have clear loading/empty/error/retry states, accessible
  labels/focus and compact layouts. Keep implementation jargon out of user flows.
- Docker is for cloud/development services; patients and centre staff need no
  Docker Desktop. Use isolated V2 names, networks, volumes, secrets and migrations.
- Run focused meaningful checks: pure unit tests; real PostgreSQL and SQLite crash
  tests; actual Windows/macOS service and signed-installer tests; browser/viewer and
  provider acceptance. Mocks never prove unattended startup or clinical rendering.
- Verify installed release artifacts, upgrade/rollback, restore, logout, sleep and
  source/cloud outages. Never label unexecuted acceptance as passed.

## ICM closeout

- On every substantive discussion/change read the map catalog plus relevant card
  and cited owner. Update only facts changed; write a session record even when
  there is no code change. Say `ICM reviewed; no runtime map change` when applicable.
- Decisions live under map/decisions, session evidence under map/sessions; no wiki.
  Keep sensitive payloads out. Link canonical facts instead of copying them.
- Run the generator rather than hand-editing generated catalog/index/twin files.
  Ghost/stub proposals become live only with source citations and actual evidence.
- Keep plan scope/checklists current before substantial implementation. A plan is
  never implicit approval to execute it. End with artifacts, verified evidence and
  remaining inputs; do not invent release success.
