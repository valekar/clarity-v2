---
id: windows-service-boot-start-2026-09-24
type: session
title: Set Windows sync service to start at boot
universe: live
status: verified
updated: 2026-09-24
revision: winsw-automatic-start-2026-09-24
---

# Set Windows sync service to start at boot

## Request and result

While implementing the bounded installer lifecycle slice, the Windows WinSW
service descriptor specified `Manual` startup. That contradicted the approved
independent service lifecycle, which requires recovery at boot. Changed
`deploy/windows/ClaritySyncService.xml` to `Automatic` while retaining the
LocalService account and existing restart policy. Updated the static descriptor
contract to require automatic startup.

## Verification

`python3 -B -m unittest discover -s deploy/windows -p 'test_*.py' -v` passed
the three static checks; two release-binary checks skipped because this Mac has
no Windows artifact or WinSW binary. The macOS temporary-root installer suite
passed 4/4 and was unaffected. No Windows service was installed or started.
This establishes descriptor intent only, not actual boot, logout or crash
recovery on Windows.

## Map review and next step

Reviewed [source and service](../objects/source-and-service.md) and
[foundation shells](../objects/foundation-shells.md). Their recorded boundaries
remain accurate: Windows packaging and installed lifecycle acceptance are open.
The next step is to run the Windows release CI and verify automatic startup,
service account access and recovery on a provisioned Windows host. No real
installation, signing or Git mutation was performed.
