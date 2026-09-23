# Lifecycle probe evidence

Record the JSON emitted by `pnpm --filter @clarity/sync-service probe:lifecycle`
with the run date and host. Keep credential contents and challenge material
out of evidence.

| Evidence                                                                      | Result |
| ----------------------------------------------------------------------------- | ------ |
| Host OS and architecture                                                      |        |
| Node version and copied binary SHA-256                                        |        |
| SQLite package and native binding SHA-256                                     |        |
| Foreground startup ID, PID, UID and startup time                              |        |
| Graceful stop time, admission closed, DB reopened, sequence stable            |        |
| Forced-kill signal and last committed sequence                                |        |
| Reopened startup ID, PID, resumed sequence                                    |        |
| Synthetic credential ACL and challenge response verified                      |        |
| Missing credential exit code and diagnostic byte count                        |        |
| `plutil -lint` result and launchd registration status                         |        |
| Temporary runtime removed                                                     |        |
| Remaining designated-host, cross-user, boot/logout, Windows and signing gates |        |
