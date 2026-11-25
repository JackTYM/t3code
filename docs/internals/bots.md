# Bots and Home

A Bot is a coordinator thread: it delegates work to crew threads, keeps memory, and is woken when
its crew or what it watches reaches a milestone. Home is the Bot whose scope is the whole
environment. User guide: [Bots and Home](../user/bots.md).

## One primitive

- A thread is a Bot when it was created with `botConfig` (`thread.create`). Nothing turns an
  existing thread into one or back: **Start a Bot from this thread**
  ([`BotService.start`](../../apps/server/src/bots/BotService.ts)) launches a new Bot seeded with a
  `full_thread_summary` handoff of the source and groups the source (and any crew it led) under it.
  The way out is archiving or settling the Bot: clients then list its crew at the top level again
  (`groupThreads`), and the server stops waking it. Reopening it takes the crew back.
- Crew is `groupedUnderThreadId`, one level deep. Threads a thread launches join its group, so a
  Bot's launches become its crew. A Bot's crew may sit in any project, which is what lets Home's
  crew work in real projects.
- Memory is `<base>/bots/<folder>/notes.md`, `preferences.md` and `tasks.md`. Every Home shares the
  `home` folder, so its memory survives Start fresh; other Bots own theirs. These files are
  user-owned. The server rewrites one only to mark a task done or reopened.
- `tasks.md` is the task list clients show. It is Markdown the Bot and the user both edit, one task
  per line, `- [ ] id | title | status | note | threadId threadId`, indented two spaces per level.
  `status` (open, in_progress, waiting, done) decides and the checkbox only mirrors it. A thread
  field needs the note field before it, empty if need be. A file is never trusted to be well
  formed ([`botTasks.ts`](../../apps/server/src/bots/botTasks.ts)): any line that does not parse,
  or repeats an earlier id, comes back as a raw line in its place and is never dropped, since a
  client acts on an id. Marking done or reopening rewrites that one line, under the same lock as
  the Bot's own writes. A Bot that saves a whole file from a stale read can still undo a mark, so
  its instructions tell it to read first.
- Explicit watches (threads outside the crew, workflow runs) live in `<base>/bots/watches.json`,
  read once and matched in memory against every milestone.

## Instructions

Bot instructions ride on every Bot turn's prompt
([`botInstructions.ts`](../../apps/server/src/bots/botInstructions.ts)), not in a file. Claude reads
`CLAUDE.md` and Codex `AGENTS.md`, and a project Bot's folder belongs to the user, so a file could
not reach every provider; a seeded file also went stale for existing Bots. The text tells a Bot to
delegate and never run shell commands, read code or edit files; `evals/mcp-tool-use` holds the
case for it.

## Who may act as a Bot

- MCP scopes carry `bot`, fixed when the thread's credential is issued, since a thread never changes
  role. It decides discovery: Bot tools and `t3_workflow` are listed only to Bots (`t3_workflow`
  only while Labs → Workflows is on), so ordinary threads pay no context for them. Every Bot tool
  call still checks `BotService.isBot`. MCP events stay hidden from every thread, Bots included:
  Bots hear milestones in-process through their wakes.
- For Home, `isBot` is "the thread is `ServerSettings.home.threadId` while Home is on". Clients
  cannot patch `home`; only the `home.*` RPCs write it. Turning Home off or starting fresh revokes
  the old thread at once, interrupts its run with `holdQueue`, and Start fresh moves its crew to the
  new Home. The active Home cannot be archived or deleted.
- Home runs in `<base>/home/`, which takes no other thread: launches there are refused unless the
  thread id is a Home id, `create_threads` is refused for a Home caller, and Home cannot be forked.

## Wakes

[`BotWakeReactor`](../../apps/server/src/bots/BotWakeReactor.ts) feeds `MilestoneHub` events to
`BotService.handleMilestone`, which wakes a crew thread's leader and every Bot watching the target
with a queued message. Its command id derives from the milestone and Bot, so a repeat replays the
first send. A workflow run a Bot starts with `t3_workflow` is watched for it. A run watch also
matches its agent-step threads' milestones (they carry `workflowRunId`) except their turns ending,
which `workflow.run_ended` reports for the run. A thread watch ends when the thread's turn settles
and a run watch when the run ends; crew are never unwatched. Milestones are local, so wakes cover
this environment's threads and runs only.

## Mail

A Bot can know about the user's email. A Cloudflare Worker turns each forwarded email into a
[`BotMailMessage`](../../packages/contracts/src/botMail.ts) and posts it, HMAC-signed, to a webhook
task; the Mac Mail reader on a linked laptop supplies history. Everything in an email is text from a
stranger, so [`BotMailService`](../../apps/server/src/bots/BotMailService.ts) treats the sender as
no signal at all.

- **Ingest reuses the webhook route.** A webhook task whose schedule has `sink: "bot-mail"` keeps
  each verified delivery's body in the mail store of the Bot the task is bound to, instead of
  starting a run. Token URL, `x-t3-signature` check, rate limit, relay forwarding, held-offline
  deliveries and the managed policy switch are the task's own. Two things differ, both because the
  store is where mail is retained and forgotten: the delivery log keeps no body, and the task
  cannot use `dedupe`, whose coalescing windows persist the request. `ScheduledTaskService` does not
  know Bots; the service above it registers the sink (`registerWebhookSink`), and a delivery with
  none registered fails like a run that could not start, so the relay sends it again.
- **Only mailboxes the user allowed.** `mailbox` is the user's own To address. The allowlist is
  Bot configuration the user sets over `botMail.setMailboxes`; the Bot has no tool for it. Mail to
  any other mailbox is dropped and logged, never stored. Empty by default.
- **Store.** SQLite (`bot_mail_messages`), keyed by the Bot's memory folder so a Home started fresh
  keeps its mail, deduped on (mailbox, Message-ID). Retention (default 90 days, per Bot) counts from
  the earlier of the sender's date and arrival, so dating mail ahead keeps nothing. A Bot holds at
  most 20,000 emails; the oldest go first, so spam cannot fill the disk. Forgetting clears the
  email in place and keeps its address, when and by whom, so forwarding it again does not bring it
  back; tombstones outlive the mail by one retention period.
- **The Bot hears a digest, not mail.** At most one wake per window (default 5 minutes, per Bot),
  through `BotService.wakeWith`, so the turn it starts counts as a wake turn for `startedByWake` and
  cannot propose or remove watchers. One line per new email (#number, mailbox, sender capped at 100
  characters, subject capped at 200, authenticated or unverified from DMARC), never bodies, framed
  as untrusted data. Control and bidi characters are stripped from what a sender wrote, and `|` in
  it is replaced, so a subject cannot forge the line's own fields. Backfilled mail is history and
  never wakes. `t3_bot_mail_search` returns the same sender and subject and no body text; there is
  no send, delete or archive tool.
- **Bodies are read by a child that must ask.** Everything in an email body is attacker text, and a
  Bot's own runtime mode is full access for Home, so `t3_bot_mail_read` refuses any caller whose
  thread is not `approval-required`, and the refusal tells the Bot to `delegate_task` with that
  mode. The caller is the one the call came from: `callerMailOwner` in
  [`handlers.ts`](../../apps/server/src/mcp/toolkits/bot/handlers.ts) loads the thread's current
  mode on every call and again before the body is returned, so a user who raises the thread while
  the read runs gets no body. Only `approval-required` passes, not "anything below full access":
  `auto` lets a classifier approve commands, and `auto-accept-edits` lets a body write files. The
  child reaches a Bot's mail only by walking its `subagent` parent links to a live Bot, never by
  naming one. The mail tools are listed to a Bot and to its delegated children (the credential's
  `botCrew` flag, set when it is issued); ordinary threads pay nothing for them. Flipping the Bot
  thread's mode around a wake was rejected: it races the user's own turns and is not crash-safe.
  What the child reports back is a derivative of the same text, so the instructions call it
  untrusted too. Claude pre-approves T3's MCP tools through the `mcp__t3-code__*` allowed-tools
  wildcard (`claudeMcpQueryOverrides`), so the child's reads do not wait for the user; its shell
  and edits still do. Codex raises an MCP elicitation for tools it considers unsafe, which the user
  would see as an approval; whether it does so for these read-only tools is not tested here.
- **Hook setup.** `botMail.createHook` makes the webhook task (`sink: "bot-mail"`, signature header
  `x-t3-signature`, `sha256=` prefix, hex, a generated secret, no dedupe) through
  `ScheduledTaskService`, bound to the Bot's thread, and returns its address and secret once; a
  second call returns the same hook without the secret. `botMail.rotateHook` saves a new secret over
  the task. A task holds one signing secret, so there is no overlap: mail signed with the old secret
  is refused until the Worker has the new one. `botMail.status` shows whether the hook exists, is
  enabled and signed, and how its last delivery ended; its address and secret are not in a status,
  which any reader can fetch.
- **Backfill** is pulled by the box: it asks the laptop's peer-only `t3_mail_backfill` through
  `PeerMcpClient` page by page, stores each page as `backfill`, and resumes from its saved cursor.
  A laptop that does not answer leaves it `waiting`, not failed.

## Mail backfill from the Mac Mail app

The box asks a linked Mac for history through the peer-only tool `t3_mail_backfill`, which only a
full-access, un-narrowed link session may list or call, as with `t3_watcher_run`. It is read-only and
runs no code. [`MailAppReader`](../../apps/server/src/mail/MailAppReader.ts) walks
`~/Library/Mail/V<n>/<account uuid>/**/*.mbox/**/Messages/*.emlx` instead of querying Mail's
Envelope Index: public descriptions of that database disagree on its date epoch and on how a row
maps to a file, while the files and their headers do not.

- **Window.** A file is written when Mail downloads the message, never before it was received, so
  an old file mtime rules a message out without opening it. The `Date` header then decides, and a
  missing or future one falls back to the mtime. Cursors name a date and a hash of the path, so
  paging is stable while mail arrives; the file index is kept for two minutes between pages.
- **Which mail.** Folders are skipped by name (Sent, Drafts, Junk, Trash, Outbox, Notes, Gmail's
  Important and Starred). Gmail's All Mail is read, because archived mail lives only there, so
  anything from the account's own address and any Mail draft (`X-Uniform-Type-Identifier`) is
  dropped by header, which also covers folders with names the list lacks.
- **Which account.** The directory is the account; its address is the majority `From` of its sent
  mail and `Delivered-To` of its received mail. The box dedupes per mailbox, so an account with no
  readable address gets a `<8 hex>@mail-app.invalid` mailbox rather than none. That is a
  placeholder, not the user's mailbox: the box keeps its mail only if the user allows that exact
  address, and otherwise counts what it dropped per placeholder, on the pull and in `botMail.status`
  (`unknownAccounts`), so the user can see what is missing.
- **Authentication.** `auth` is read only from the topmost `Authentication-Results` header, and only
  when its authserv-id is the receiving provider's: `mx.google.com` for an account with a `[Gmail]`
  folder, `bimi.icloud.com` (read off real iCloud messages) for one whose own address is on
  icloud.com, me.com or mac.com. Receivers prepend their headers, so anything a sender forged sits
  below, and another provider's id on top is itself a forgery. Mail names iCloud's folders as it does
  any IMAP server's, so the address is the only signal; an iCloud account on a custom domain or a Hide
  My Email alias gets no verdict, never a wrong one.

## Watchers

A watcher is a script that polls for free and wakes the Bot, a model call, only when it trips.
The Bot proposes them, and a Bot reads untrusted email and chat, so a proposal is never trusted:
a watcher runs only as the exact version the user approved after reading its source and a dry run.
[`WatcherService`](../../apps/server/src/bots/WatcherService.ts) owns this and registers one pass
with the `Scheduler`.

- **Versions.** A proposal is stored as `<base>/bots/<folder>/watchers/<name>/<sha256>/` holding
  `run` (node or sh source) and `watcher.json`; the hash covers both. Which hash is approved, who
  approved it and where it runs live in `<stateDir>/watcher-approvals.json`, which only the service
  writes. A directory the Bot writes under `bots/` approves nothing, and the loop runs what that
  file lists, not what it finds on disk. The file carries an HMAC kept with the server's other
  secrets, which a Bot cannot read: one that fails the check, or has no signature, approves
  nothing, so every watcher waits for the user again, a warning is logged and `botWatcher.list`
  reports `approvals: unverified`.
- **Any change stops it.** A different version becomes the pending one and the approved version
  stops until the user approves the new one or rejects it, which resumes the old. The user's
  actions are protected RPCs (`botWatcher.*`) that need terminal access, as saving a workflow
  file does, because each runs code. Approval must name the current pending hash, and the
  server refuses it unless a dry run of exactly that hash has completed where the watcher will
  run, whatever the run found: a client that skips "Run once" cannot approve what nobody saw
  behave. Moving an approved watcher (`setRunsOn`) needs the same first run in its new place.
- **The user can always stop it.** `pause` keeps the approval and stops runs, `remove` deletes the
  watcher, and neither depends on what woke the Bot or whether it is still live. Both need only
  operate access since they run nothing; `resume`, which starts approved code again, needs
  terminal access like approving.
- **No Bot path to approval.** There is no Bot-callable approve and no Bot-callable dry run: a Bot
  that could dry-run its own proposal would execute it before anyone read it. The propose and
  remove tools are also refused to a turn that did not begin with the user typing, which
  `BotService.startedByWake` decides from the run's first message: a `bot-wake:` message, another
  agent's, a scheduled task's, or one that cannot be found all count as not typed. A user who
  steers a wake turn does not change that: the turn stays refused. The web "Ask the Bot to revise" therefore sends its message queued behind any active run, so the proposal comes from a new turn that begins with the user's text.
- **Running.** The verified bytes are read once, hashed, written to a fresh 0700 scratch directory
  and executed from that copy, never from the stored path, so a rewrite after the check changes
  nothing. Watchers are trusted code, not sandboxed: the scratch directory is the cwd and
  `TMPDIR`, stdin is closed, output and time are capped, one script runs at a time, and the
  environment is an allowlist (`inheritEnv: false`). A dry run uses the same path with
  `T3_WATCHER_DRY_RUN=1`.
- **Where.** A watcher records `runsOn`, `local` or a linked environment. For a linked one this
  server, the box, calls the peer-only tool `t3_watcher_run` through `PeerMcpClient` with the
  source and its sha256. The receiving server accepts it only from a linked session paired with
  full access and not narrowed below it, refuses source that does not hash to what it was sent
  with, and runs those bytes through the same private-copy path as a local run. The box attests
  the approval; the laptop keeps no approvals of its own. It returns the exit and output, and
  the box judges, dedupes and frames them exactly as for a local run. A peer that does not
  answer is `waiting`, not failing: nothing is counted, `failing` and its backoff stay as they
  were, and it is asked again after a minute (the link itself is kept alive by
  `PeerLinkKeepalive`). A peer that answers with a refusal is a failure like any other.

A run is healthy on exit 0 with stdout matching `expect`, if set. A wake is deduplicated per
failure: a trip, or new output, wakes at once, and the same output wakes again after 15 minutes,
doubling up to 24 hours. Recovery clears the state silently. `state.json` is saved with the wake
`pending` before `BotService.wakeWith` queues it, and its key carries the failure's start, wake
count and output fingerprint, so a restart resends the same key instead of waking twice. The
output reaches the Bot framed as untrusted data, with a random tag.
