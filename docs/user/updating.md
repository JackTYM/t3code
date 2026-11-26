# Updating T3 Code

T3 Code clients and servers can run on different machines and must share a compatible orchestration protocol. When a server or provider is behind, the sidebar update button and **Settings → Environments** handle updates.

## Update everything at once

Click the **Update** button at the bottom of the sidebar (web or desktop) to update outdated providers, behind servers, and the desktop app in one step.

- Hover to preview what will update; click while running to view per-machine progress or retry failures.
- Confirmation dialogs show which machines are skipped (offline or manual-only) and how many active threads will pause/resume.
- Choose **Later** on the desktop restart countdown to restart when ready.

## Switch between Stable and Nightly

In the desktop app, change **Settings → About → Update track** to switch connected machines together.

- Moving a background service to an older Stable release requires running `t3 update --channel stable --allow-downgrade` on that host.
- A switch is blocked if the machine's database has schema changes the target track doesn't support yet. macOS desktop apps must switch on that Mac.

## Continue threads after restarts

**Settings → Maintenance → Continue threads after restarts** is enabled by default. After an update, crash, or reboot (once T3 Code starts again), supported active threads automatically resume—and threads waiting on subagents or monitors are woken and notified that background work stopped.

- Threads waiting for your approval/answer/secret—or archived, snoozed, or settled—are not auto-resumed.
- After 3 consecutive crash recoveries of an unfinished turn, the thread waits for your next message.
- Updating from V1? Read [Threads from older T3 Code versions](./thread-migration.md).

## Update a connected server manually

| Situation                           | Action                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Background service / desktop server | Click **Update server** in **Settings → Environments** (desktop hosts relaunch automatically).        |
| Installed `t3` CLI                  | Run `t3 update <version>` on the host (then `t3 service restart` if you declined the restart prompt). |
| `npx` server                        | Stop the server and relaunch with `npx t3@<version>` and your usual flags.                            |
| Package manager (Nix, AUR)          | Update via your package manager.                                                                      |

Each server checks npm/Homebrew/pnpm using its own local registry and proxy settings.

## UI updates

A release can include a newer interface for the server you are connected to. T3 Code
downloads it in the background, and you switch to it without reinstalling or
restarting anything. Running threads and agents are not touched.

When one is ready, a **UI update ready** button appears in the sidebar. Click it and
this window reloads on the new interface; other open windows keep the old one until
you reload them. **Settings → About** shows the active interface version, with
**Check now**, **Update now** and **Revert to built-in**. The server looks for a new
interface when it starts and every 6 hours; **Update now** checks, installs and reloads
this window in one step without waiting for the button to appear.

- It only offers an interface built against the same server contracts as your server.
  A release that changes the server or those contracts still needs the full update
  described on this page.
- If a new interface fails to start, T3 Code returns to the previous one after about
  three minutes. Restarting the server before the new interface has started does the
  same.
- If the interface is unusable, open the app with `?ui=builtin` added to its address to
  load the built-in interface for that page load.
- To remove every downloaded interface, stop the server and run `t3 ui reset`.

## Update providers

Open **Settings → Providers** and click **Update now** on individual providers or **Update all** across connected environments. Running chats keep using their current CLI until they end; new sessions and model catalogs refresh automatically. (Provider update checks in **Settings → Maintenance** must be enabled to fetch model catalog updates.)

## Unsigned macOS builds from the fork

A Mac app that is not signed with an Apple Developer ID cannot update itself, and a DMG
downloaded in a browser is blocked until you run `xattr -cr` on it. On these builds the
update button downloads the DMG for you without that block, then asks before it opens the
installer and quits T3 Code and its background servers. Drag the new app into Applications
to finish. Running threads are interrupted and continue after you reopen the app.

## Mobile updates

- Update connected environments and providers from **Settings → Environments** on mobile.
- Update the mobile app via the App Store or Google Play (background over-the-air updates apply on next app switch and preserve drafts/queued messages).

### Sideloaded iOS builds from the fork

An IPA from the fork's releases updates two ways. JavaScript-only releases arrive in
the background through the same update prompt as above. A release that changes native
code needs a new IPA: add `https://jacktym.github.io/t3code/source.json` as a source in
Feather and its **Updates** tab offers the latest `-unsigned-appgroup` build to re-sign.

The app only looks for JavaScript updates when the build was made with the repository
variable `T3CODE_MOBILE_UPDATES_URL` set to the deployed update proxy (see
`scripts/ota-proxy`). Without it, updates are off. An update is only taken by a build
with the same native code, so an older install quietly ignores one meant for a newer IPA.

## Troubleshooting

- **Version mismatch**: Update whichever side (app or server) the connection notice names.
- **Failed update**: Retry once; confirm you updated the host machine (not just the client) and that only one server owns the T3 home directory.
- **macOS Alpha → Beta**: Open `/Applications/T3 Code (Beta).app` manually and re-pin it to the Dock.
- **Desktop won't start**: Use the recovery window's **Update** button, install the linked last-working version, or **Copy details** for a bug report.
