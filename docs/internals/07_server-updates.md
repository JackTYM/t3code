# Server updates

## Launcher ownership and compatibility

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime selected by systemd,
launchd, or Task Scheduler and is the only runtime writer of durable service state. Server children
request updates over inherited IPC and never rewrite their service definition. Foreground CLI
processes do not self-update.

Remote updates replace only the server child, not the launcher, so every existing background service
lags behind after a launcher-protocol bump. Keep new server runtimes compatible with the previous
launcher protocol unless impossible, and validate protocol compatibility during preflight.

Installations use exact versions and stage/preflight before publishing an immutable runtime so
restarts never depend on npm cache eviction or a moving tag.

## Commit boundary and database rollback

1. Record the pending update durably (atomic rename + fsync) before stopping the old child.
2. Refuse the update if a database snapshot will not fit on disk. After the old child exits, snapshot
   SQLite (main, WAL, SHM) once per update so failed trial migrations are reversible without down
   migrations. Never overwrite that snapshot on retry. Files outside SQLite (such as attachments)
   are outside this rollback boundary.
3. Start the new runtime as a trial. It must finish migrations, acquire fallible dependencies, bind
   HTTP, and hold long-running roots at the activation gate before reporting `prepared`.
4. Only after the launcher commits the new version durably and replies `committed` may the child
   release activation gates and accept work. A failed or timed-out trial stops and restores the
   snapshot before booting the old version.

## Client acknowledgement

An accepted update RPC is only pending. Clients correlate the launcher's update ID with the
reconnected ready state to distinguish commit from rollback. Desktop updates use a two-phase handoff
(prepare token while connected, commit after receiving it) because installing stops the bundled
backend.

## UI bundles

A server can switch its served web client to a newer one from the release feed
without restarting, so running agents are untouched. The
[UiBundleService](../../apps/server/src/uiBundles/UiBundleService.ts) stages and
verifies a bundle, then flips the static root. Compatibility is a hash of the wire
contracts plus the desktop bridge files, written by
[compute-ui-compat.ts](../../scripts/compute-ui-compat.ts), and an equal version core.
`orchestrationProtocol` is too coarse: contracts drift without a bump. The bridge files
count because the Electron preload is not swapped with the UI. The hash cannot see
main-process IPC handler changes, so a UI that calls a new handler can pass the check
and fail at runtime; changes to what a channel does need the full update.

The new UI is untrusted until it mounts and confirms, so each apply starts a timer and
an unconfirmed bundle reverts when it expires. A server that restarts before
confirmation also reverts, because it cannot know the UI ever booted. A reverted version is
not offered again. The bundle is trusted as far as the release feed: sha256 detects
corruption, and there is no signature.

## Mobile JS updates on a fork

The iOS app bundles its own JavaScript, so UI bundles do not reach it; it uses
`expo-updates` against a static site on GitHub Pages. expo-updates refuses a manifest
without an `expo-protocol-version` response header and Pages cannot set headers, so
[scripts/ota-proxy](../../scripts/ota-proxy/worker.ts) is a stateless Worker that adds the
headers. Assets are fetched from Pages directly. Compatibility is expo-updates' own runtime
version, the native fingerprint read from the archived app, so a native change is never
applied as a JS update. With `T3CODE_MOBILE_UPDATES_URL` unset the app does not enable
updates at all, because the default would be T3's Expo project, which serves T3's JavaScript.

## Recovering interrupted threads

- On startup, retire effects tied to the lost process before admitting new work.
- Persist restart-continuation intent in the durable outbox and wait for activation before running
  it so slow providers never delay readiness or the launcher's commit boundary.
- Cap consecutive crash recoveries per unfinished turn so a crashing turn cannot loop forever.
- Never auto-continue a turn that is archived, settled, snoozed, user-stopped, or waiting on a
  blocking user action (approval, question, or secret).
