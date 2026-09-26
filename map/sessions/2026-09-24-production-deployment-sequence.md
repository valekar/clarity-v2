---
id: production-deployment-sequence-session-2026-09-24
type: session
title: Explain the ordered production deployment path
universe: live
status: verified
updated: 2026-09-24
revision: production-deployment-sequence-session-2026-09-24
---

# Explain the ordered production deployment path

## Request and result

The user requested clear, sequential production deployment steps. The response
routes from the [active plan](../../docs/ACTIVE.md) and its
[deployment section](../../docs/01-final-clarity-v2-plan.md#38-docker-packaging-updates-and-recovery):
finish open release gates; provision isolated V2 cloud infrastructure; configure
private storage, identity, secrets, mail and HTTPS; deploy cloud services; prove
backup and restore; install the native centre service and Electron application;
run synthetic end-to-end and outage checks; then authorize a limited staff pilot.
Recipient sharing remains a separate later gate. The working assumption is
Coolify on Hetzner for cloud services, with local Orthanc and an independent sync
service at the centre. This is a proposed sequence, not deployment evidence or a
change to the plan's open decisions.

## Verification

Inspected the active plan, engineering rules, ICM source/service and staff
identity cards, and existing deployment/auth clarification. Reviewed current
official Coolify Docker Compose, Hetzner Object Storage, Cloudflare Tunnel and
Orthanc REST documentation. The current disposable stack still uses synthetic
components, and installed-service, production storage, authentication change,
signing, real-centre and restore acceptance remain open. No service was deployed.

## Map review and next step

ICM reviewed; no runtime map change. Resolve the cloud hosting interpretation,
desired Hanko password identifier, OI-02/03/04/05/09 and production storage
protection before converting the sequence to an executable release runbook.
Keep the staff-only pilot separate from OI-06/07 recipient delivery acceptance.
