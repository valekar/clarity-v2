---
id: synthetic-login-support-session-2026-09-24
type: session
title: Confirm synthetic Hanko passcode delivery
universe: live
status: verified
updated: 2026-09-24
revision: synthetic-login-support-session-2026-09-24
---

# Confirm synthetic Hanko passcode delivery

## Request and result

The user asked how to set up sign-in after no code arrived in their normal
mailbox. The [interactive demo](../../docs/evidence/41-interactive-synthetic-desktop-demo.md)
already routes Hanko email through local Mailpit, so the disposable demonstration
does not send mail to an external inbox. The demo administrator uses the email
printed at launch and enters a one-time Hanko passcode from Mailpit. No fixed
staff password exists.

## Verification

The local dashboard and Mailpit responded. Mailpit contained previous passcode
messages for the synthetic administrator and for an external address; only
recipient and timestamp metadata were inspected for the new message, with no
passcode recorded. The Electron app requested a fresh code for the existing
synthetic administrator, Mailpit received a new message, and Electron showed
the six-digit passcode screen. The Hanko demo configuration gives codes a
five-minute lifetime. No external SMTP delivery or completed sign-in was
claimed.

## Map review and next step

ICM reviewed; no runtime map change. For an external inbox, a separate
production SMTP configuration and associated deployment inputs are required.
The user can complete the local demo using the newest Mailpit message.
