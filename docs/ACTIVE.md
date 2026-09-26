# Active V2 plan

| Plan                                           | Status                                                                                                                                                                                                                                                                                                                                                                                | Next step                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01 — Clarity V2](01-final-clarity-v2-plan.md) | Synthetic separate-source Orthanc → compiled service → cloud Ready and two SIGKILL recovery points passed in a disposable Docker stack. The interactive Electron profile signed in through Hanko, tested and saved local Orthanc settings, and admitted two CTs to Ready; the second arrived on the five-minute poll after Electron exited. Native OS service lifecycle, packaged cross-OS app, clinical breadth, signed installers and external sharing remain open. | Prove installed macOS/Windows service continuity and packaged desktop acceptance; gather real-centre inputs only when approved. |

The 24 September desktop clarification is in plan version 1.4 as BR-08/09/10,
TR-13/14/15 and tasks P2.4/P3.5. Hanko owns sign-in and account creation;
Clarity's active database membership grants staff access. The web root now
routes to sign-in instead of the inert preview, and the protected staff pages
use left navigation. The administrator's bundled local Settings page is now
loaded inside the existing Electron window; it uses a fresh authorized bridge
to test and save a loopback Orthanc source without exposing credentials to the
hosted page. The earlier pop-up proof is superseded by this
[in-window revision](evidence/42-in-window-source-settings.md); the native
synthetic Settings → source form → Settings round trip, test and save passed. A
[disposable interactive run](evidence/41-interactive-synthetic-desktop-demo.md)
reached Ready twice, including a five-minute poll after Electron quit, and the
source-health panel changed to Healthy. The plan has
**7 of 30** task boxes checked; P2.4/P3.5 remain open for installed macOS and
Windows proof and service lifecycle.
Plan version 1.5 adds BR-11 for Indian mobile entry and display in the doctor
directory. The [synthetic doctor UI correction](evidence/43-indian-doctor-directory-ui.md)
styles the add/search page, loads the first 20 doctors without a search term,
and shows Indian-formatted numbers. P6.2 stays open for recipient policy,
verified sharing, QR and final Send.
Plan version 1.6 adds BR-12 for native operating-system window controls. The
[desktop window controls proof](evidence/44-desktop-window-controls.md)
tracks the framed Electron window and removal of the duplicate in-page actions;
P2.4 remains open for packaged macOS/Windows acceptance.
The running synthetic service also refreshed source health and its cloud lease
each minute between five-minute Orthanc polls, so the UI does not go stale
solely because the configured discovery interval exceeds two minutes.

The prior Docker BuildKit issue cleared. A disposable
`CLARITY_COMPILED_SYNC_PROOF=1` run completed the separate-source compiled
service crash/recovery and cloud restore checks. See
[connected crash evidence](evidence/33-compiled-sync-crash-recovery.md). This
proof does not install a native OS service or establish a real centre connection.

Synthetic-only integration remains the approved scope. Clinic OS/Orthanc details,
production cloud/service credentials, signing and recipient policy are still
release inputs. External Generate and send stays unavailable until OI-06 recipient
verification and delivery gates are accepted. The existing V1 plans remain
historical reference material, not V2's execution queue.
