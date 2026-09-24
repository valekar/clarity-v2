# Native installers

The macOS scaffold can build an unsigned `.pkg` from a prebuilt standalone
release, includes an inert system LaunchDaemon template, provisions private
service data/log directories when the dedicated `_clarity-sync` account already
exists, switches versioned release symlinks atomically, and removes app/service
files while preserving queue, spool, configuration and logs. Tests exercise
these operations under disposable temporary roots. The package does not
bootstrap launchd, and the template stays outside `/Library/LaunchDaemons`
until protected credentials and installed lifecycle are proven. The compiled
service has passed a bounded disposable source-to-Ready activation, not a
machine-service installation.

A Windows release assembly script and WinSW service descriptor now exist; the
descriptor requests automatic boot startup under LocalService. Static checks
have run, but no Windows artifact or WinSW binary was executed here. No actual
OS installation, service registration, package signing/notarization, real
credential-store access, or clean-machine lifecycle proof exists. P5 checkboxes
remain open pending designated host/account provisioning, final service and
desktop payloads, signed native artifacts, and the
close/quit/logout/boot/sleep/wake/offline/revocation/upgrade matrix.
