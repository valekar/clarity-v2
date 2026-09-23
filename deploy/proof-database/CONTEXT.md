# Disposable PostgreSQL schema proof

Runs the database migration and synthetic constraint/CAS assertions against a
fresh, loopback-only PostgreSQL container. The fixed image digest and isolated
`clarity_v2_proof` database prevent the proof from selecting a project database.
The container is force-removed on exit; the proof uses no patient or V1 data.
