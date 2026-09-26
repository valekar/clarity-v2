---
id: deployment-auth-clarification-session-2026-09-24
type: session
title: Clarify local Orthanc entry and proposed cloud authentication
universe: live
status: verified
updated: 2026-09-24
revision: deployment-auth-clarification-session-2026-09-24
---

# Clarify local Orthanc entry and proposed cloud authentication

## Request and result

The user asked how to put a study in local Orthanc, where Hetzner object-storage
keys and identity data should reside, whether a Coolify/Hetzner deployment should
use Hanko username/password instead of Mailpit passcodes, and whether a
Cloudflare tunnel is needed. The current [plan](../../docs/01-final-clarity-v2-plan.md)
keeps local Orthanc private and makes the local service initiate cloud requests;
the cloud issues scoped, expiring object-upload authorization. Hanko owns staff
authentication and Clarity's database owns roles. Current demo Hanko uses Mailpit
passcodes and MinIO storage; Coolify, Hetzner Object Storage and production mail
are not deployed. Hanko password support exists upstream, but the user's preferred
login identifier and exact Coolify role need clarification before changing the
active plan or runtime.

## Verification

The synthetic Orthanc `/system` endpoint responded under the saved local source
configuration, which has a five-minute poll interval. A DICOM fixture with only
synthetic patient fields was generated at the ignored local path
`.local/manual-orthanc-test.dcm` for manual Orthanc Explorer upload; it was not
uploaded by this session. Inspected the current compiled ingestion client and
cloud admission code: the service accepts signed object-upload URLs and does not
load S3 root keys. Official Hanko v3.0.4 configuration documents password and
username support; official Coolify, Hetzner and Cloudflare documentation was
reviewed. Hetzner's documentation says object storage has no default data-at-rest
encryption, an unresolved clinical-storage gate.

## Map review and next step

ICM reviewed; no runtime map change. Keep the existing passcode, MinIO and
synthetic-only plan status until authentication, hosting and storage decisions
are confirmed and implementation/acceptance evidence exists. A real service
release still needs protected device credential storage, production storage
selection/encryption, HTTPS domain topology, password enrollment/recovery and
native installer proof.
