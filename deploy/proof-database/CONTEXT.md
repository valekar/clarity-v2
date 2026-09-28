# Disposable PostgreSQL schema proof

Runs the database migration and synthetic constraint/CAS assertions against a
fresh, loopback-only PostgreSQL container. The fixed image digest and isolated
`clarity_v2_proof` database prevent the proof from selecting a project database.
The container is force-removed on exit; the proof uses no patient or V1 data.
The staff proof now checks that the application runtime cannot enroll a Hanko
identity and that the private operator can perform the enrollment and first
administrator bootstrap after migration 0018.
