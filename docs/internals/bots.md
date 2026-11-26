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

### Health wakes

[`RepairService`](../../apps/server/src/bots/RepairService.ts) tells a Bot when the machinery
around it keeps failing: a watcher whose last 3 scheduled runs all failed, a reviewer that failed
to run 3 times for one Bot in an hour, or a Bot run that ended `failed`. A failure is an episode.
The first report wakes the Bot at once, and a later report wakes it again after 1 hour, then 2, up
to 24, for as long as reports keep coming; recovery clears the episode. The wake id is
`bot-wake:health:<id>:<n>`.

- **Not influenced, so it carries no outside text.** A health wake is the one wake
  `BotHoldService` does not treat like mail or a watcher: its prefix matches neither check, so a
  turn it starts is as free as one the user typed. That only holds because the text is built from a
  number, ISO times, a hex id and a name that passed a no-whitespace pattern, never from script
  output, a reviewer's reason or a purpose. A signal whose name does not pass is refused, not
  cleaned. Do not add a field to it that a stranger could have written.
- **Free until it reads outside text.** In a health turn any read beyond the Bot's own memory (a
  thread's history holds old watcher output and mail, an issue or a PR is a stranger's words, and
  `t3_bot_watcher_list` returns source a turn that was influenced may have written) taints the run
  like `t3_bot_mail_search` does, so its consequential calls are held from then on. The list is
  "every read-only tool that is not a `t3_bot_*` tool", not names, so a tool added later is covered.
  Other turns are unchanged: reading is not a taint there.
- **A health turn's own failure is not a signal.** A failed run that began with a health wake would
  wake the Bot into the same failure again, so `handleMilestone` skips it, and a failed run it
  cannot find.
- **"In a row" for a watcher** counts scheduled runs that failed (a non-zero exit, a timeout, a
  spawn error, a refusal, output cut in `events` mode, or output `expect` rejects), kept as
  `failing.runs` in the watcher's `state.json`. Any healthy run, including an `events` run with
  news, starts over. A run where the linked environment did not answer is neither: `waiting` leaves
  the count as it was. A new approved version or a move starts clean.
- **State** is `<stateDir>/repair-state.json`, signed like the watchers' approvals with a key a Bot
  and a script cannot read, because a later step trusts it to say which signals the server wrote
  and which threads are repair crews. It holds `episodes` and `repairs`; a file from before
  `repairs` existed (the episodes alone) still reads. A signal's episode is saved with the wake
  before it is queued and settled after, so a restart resends the same key instead of waking twice.
  A file that fails its signature is dropped whole.

### Repair start

`t3_bot_repair_start({ signalId })` starts a crew that fixes the failure a health wake named. The
Bot supplies the id and nothing else; the project (`home.repairProjectId`, set in Settings → Home),
branch (`repair/<signalId>`, `-2` for the retry), model, isolation and brief are the server's. The
crew is an ordinary crew thread in a worktree, grouped under the Bot, no higher in runtime mode
than the Bot.

- **The turn proves itself three ways, because a client picks its own message ids.** The Bot's
  active run began with a message whose id is exactly `bot-wake:health:<12 hex>:<n>`, that message
  is `createdBy: "system"` (everything a client sends is `user`), and the id's signal is the tool's
  argument and is in the signed registry for this Bot. `BotHoldService` checks only the id shape,
  to refuse early outside a health turn and to leave the tool allowed after the turn was tainted;
  `RepairService.startRepair` is the check that counts.
- **The brief is a constant plus fixed fields** ([`briefText`](../../apps/server/src/bots/RepairService.ts)):
  a signal id, a pattern-checked name and thread id, a count, ISO times, an evidence pointer and
  the Bot's thread and folder. Nothing a script printed, a reviewer said or a Bot wrote enters it.
  The crew reads the evidence itself and is told it may hold outside text. The protected paths in
  the brief are `PROTECTED_PATHS`, the one list the merge guard reuses.
- **Bounds live outside the episode map**, because an episode goes when the failure recovers and
  is swept a day after its last wake. One crew runs per signal; a Bot gets three starts in any
  24 hours; a crew thread whose run ends `failed` (or that was deleted unfinished) is a failed
  attempt, and the second one gives the signal up with one wake, `bot-wake:health:<id>:gaveup`.
  That id does not match the health pattern, so the turn it starts cannot start a repair.
- **Crew thread ids are written before the launch** (`repair-crew:<signalId>:<n>`, also the launch's
  command id, so a retry replays), and rolled back if the launch is refused. `repairOf(threadId)`
  says which repair a thread belongs to.

## Model

A Bot runs on a cheap model and may raise its own with `t3_thread_configure` for a task that needs
more reasoning (its instructions say so). The raise lasts one turn: the server gives the thread back
the model it had before the Bot's first raise, so the baseline is whatever the thread was on, not a
stored setting, and it holds for Home and for any thread started as a Bot.

- **Only the Bot's own change is undone.** The tool handler tells
  [`BotService.noteOwnModelChange`](../../apps/server/src/bots/BotService.ts) when a live Bot sets
  the model of its own thread (not a subagent's, not another thread's). The record is the baseline
  and the model the Bot set; a second raise keeps the first baseline, unless the current model is no
  longer the one the Bot set, which means the user changed it and their pick becomes the baseline.
- **The end of the turn is the Bot's own `thread.run_settled`.** `handleMilestone` receives it from
  `BotWakeReactor` like any wake, and settles the record for that run: if the thread is still on the
  model the Bot set, it dispatches the baseline back (`provider.switch` when the provider differs,
  which a running turn refuses); if the user changed it meanwhile it leaves it. Either way the
  record is dropped, so a user's own change is never reverted. A queued wake can start the next run
  before this dispatch lands, so that run may still use the raised model.
- **Free in a mail-influenced turn.** Raising the Bot's own model never changes permissions and only
  costs tokens, so [`BotHoldService`](../../apps/server/src/bots/BotHoldService.ts) lets
  `t3_thread_configure` through when it names no thread or the Bot's own thread and no linked
  environment. Aimed at any other thread it is held like any other call.
- **In memory.** A restart drops the record and leaves the thread on the model the Bot set until
  the user changes it.

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
  any other mailbox is dropped and logged, never stored. Empty by default. A forwarded drop is also
  counted in `bot_mail_settings.dropped_json`: a total and the newest ten distinct mailbox names
  with their counts, never a sender, subject or body. A sender chooses what `mailbox` says, so only
  a name shaped like an address is kept by name. Allowing a mailbox removes its entry and its
  count; `botMail.clearDropped` forgets the rest. History pulls are not counted here, since they
  have their own placeholder-account tally.
- **Store.** SQLite (`bot_mail_messages`), keyed by the Bot's memory folder so a Home started fresh
  keeps its mail, deduped on (mailbox, Message-ID). Retention (default 90 days, per Bot) counts from
  the earlier of the sender's date and arrival, so dating mail ahead keeps nothing. A Bot holds at
  most 20,000 emails; the oldest go first, so spam cannot fill the disk. Forgetting clears the
  email in place and keeps its address, when and by whom, so forwarding it again does not bring it
  back; tombstones outlive the mail by one retention period.
- **The Bot hears a digest, not mail.** At most one wake per window (default 5 minutes, per Bot),
  through `BotService.wakeWith`, so the turn it starts counts as a wake turn for `startedByWake` and
  cannot create or remove watchers, though it may revise one the Bot already has. One line per new email (#number, mailbox, sender capped at 100
  characters, subject capped at 200, authenticated or unverified from DMARC), never bodies, framed
  as untrusted data. Control and bidi characters are stripped from what a sender wrote, and `|` in
  it is replaced, so a subject cannot forge the line's own fields. Backfilled mail is history and
  never wakes. `t3_bot_mail_search` returns the same sender and subject and no body text; there is
  no send, delete or archive tool.
- **Bulk mail is stored, never announced.** `BotMailMessage.bulk` is judged from the sender's own
  headers where the full message exists: `List-Unsubscribe`, `List-Id`, `Precedence: bulk|list|junk`,
  `Auto-Submitted` other than `no`, and a short list of machine sender names (`noreply`,
  `do-not-reply`, `newsletter`, `marketing`, `notifications`, with `+tags` ignored). The Worker
  ([`bulk.ts`](../../infra/mail-worker/src/bulk.ts)) and the Mac Mail reader (`isBulkMail` in
  `MailMessageParser.ts`) each carry the rule, because the Worker is a separate bundle; keep them
  identical. The sender writes all of those headers, so `bulk` sorts mail and vouches for nothing:
  the worst a hostile sender gains is mail that does not wake the Bot, which is still stored and
  searchable. Bulk mail is born announced, so it can never be what wakes a Bot. A wake for ordinary
  mail adds one count line of bulk mail received since the previous wake, and
  `t3_bot_mail_search` leaves bulk out unless `includeBulk` is set, marking each bulk result.
- **Bodies are read by a child that can only read.** Everything in an email body is attacker text,
  so the model that reads it must have nothing a hostile email could use. A Bot starts that reader
  with `delegate_task` role `mail-reader`; the server marks the child's thread `mailReader` at
  creation and the mark never changes. Asking a human per read was dropped: on Claude the
  `mcp__t3-code__*` allowed-tools wildcard (`claudeMcpQueryOverrides`) pre-approves every T3 tool,
  so an `approval-required` child had no prompt to wait on and still held `t3_thread_send` and the
  rest. The reader is limited in three layers, none of them prompt text:
  - **Sandbox.** `RuntimePolicy` gives a `mailReader` thread `sandboxPolicy: readOnly` and
    `approvalPolicy: never` whatever its mode. Claude then offers only Read, Glob and Grep with
    nothing pre-approved (`dontAsk`), plus the read-only T3 tools in
    `CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS`, which includes `t3_bot_mail_read`; Codex runs it in its
    read-only sandbox. `delegate_task` also forces its runtime mode to `approval-required`.
  - **MCP.** The credential carries `mailReader` (set when it is issued), and the global visibility
    gate in [`McpHttpServer`](../../apps/server/src/mcp/McpHttpServer.ts) hides every tool but
    `t3_bot_mail_read` from it, on list and on call, so it cannot start, message or schedule
    anything. This holds on every provider, including ones whose own sandbox is weaker.
  - **Tool.** `callerMailReader` in
    [`handlers.ts`](../../apps/server/src/mcp/toolkits/bot/handlers.ts) serves a body only to a
    delegated child whose credential is a mail reader, and finds the Bot by walking its `subagent`
    parent links to a live Bot, never by naming one. A Bot, a fork and an ordinary child are
    refused. `t3_bot_mail_search` (sender and subject only) is the Bot's alone.
    A hostile email can therefore at worst skew the reader's report. That report is a derivative of
    the same text, so the instructions call it untrusted. The one `delegate_task` role is Bot-only: a
    non-Bot caller is refused, and a mail reader cannot be started in a linked environment. Not
    verified here: whether Codex raises an MCP elicitation for `t3_bot_mail_read` (it is annotated
    read-only, which Codex treats as safe), and how other providers apply a read-only sandbox; the MCP
    gate holds either way.
- **Mail-influenced turns hold consequential calls.** The reader is not the only way a hostile
  email reaches the Bot: the digest names senders and subjects, and the reader's report is shaped
  by the body. [`BotHoldService`](../../apps/server/src/bots/BotHoldService.ts) calls a Bot's turn
  influenced when its run began with a mail digest (a `bot-wake:mail:` message) or a watcher wake
  (`bot-wake:watcher`), began with a mail
  reader's report (the run's first message is the completion delivery of a task whose child is a
  `mailReader`), or has since searched mail or started a reader. Starting a reader taints the run that did
  it, so a Bot cannot read the child's thread or poll its task from a turn the user typed. In an
  influenced turn the middleware in `McpHttpServer` (`layerBotMailHold`, global, so it sees every
  toolkit's calls) answers any Bot call that is not read-only, not the Bot's own `t3_bot_*` memory
  tool or `task_cancel`, not `t3_thread_configure` on the Bot's own thread (see Model), not a mail
  reader's start and not a message to its own crew with an error result instead of running it. That is a deny-by-default list, so a tool added later is held
  until someone decides it is free; anything naming a linked environment is held too. Thread
  launches, other delegations, messages outside the crew, schedules and project changes therefore
  wait for the user. A held call is stored in memory with its arguments (a restart drops it, and
  the Bot asks again), listed by `botHold.list` and shown on the Bot popover. Allowing needs
  terminal access, as starting a watcher does, and wakes the Bot with the call as the user saw
  it; the wake is not a mail message, so that turn is not itself held. A hostile context can still
  steer that turn, which is why the user reads the arguments first. A turn a watcher woke is held
  the same way (see Watchers). Creating or removing a watcher is refused in any turn the user did
  not type, and a revision of one the Bot already has is not.
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

A watcher is a script that polls for free and wakes the Bot, a model call, only when something
happens. The Bot writes them, and a Bot reads untrusted email and chat, so a script is never
trusted on the Bot's word: a reviewer model reads it before it first runs.
[`WatcherService`](../../apps/server/src/bots/WatcherService.ts) owns this and registers one pass
with the `Scheduler`.

- **Versions.** A proposal is stored as `<base>/bots/<folder>/watchers/<name>/<sha256>/` holding
  `run` (node or sh source) and `watcher.json`; the hash covers both. Which hash is live, who
  approved it and where it runs live in `<stateDir>/watcher-approvals.json`, which only the service
  writes. A directory the Bot writes under `bots/` approves nothing, and the loop runs what that
  file lists, not what it finds on disk. The file carries an HMAC kept with the server's other
  secrets, which a Bot cannot read. A file that fails the check, or has no signature, is dropped
  with every record in it: nothing is re-reviewed, nothing runs, a warning is logged and
  `botWatcher.list` reports `approvals: unverified`. The Bot must propose each watcher again, in a
  turn the user typed.
- **Modes.** `health` (the default) is healthy on exit 0 with stdout matching `expect`, if set, and
  wakes the Bot when it is not. `events` is for news: exit 0 with empty stdout is quiet, exit 0 with
  output is one wake carrying that output, and anything else is a failure. Stdout is capped, and in
  `events` mode output that reaches the cap is a failure: the script's cursor has already moved
  past what was cut, so the Bot would hear an event with a hole in it.
- **The state folder.** `$T3_WATCHER_STATE_DIR` is a folder per watcher for cursors and seen ids.
  It is not a version: a revision keeps it, and removing the watcher deletes it. A dry run gets a
  throwaway one, so trying a script never moves its cursor. On a linked environment the folder
  lives there, keyed by this server's id, the Bot and the name, so two boxes linked to one laptop
  do not share it. A laptop that predates the key leaves `T3_WATCHER_STATE_DIR` unset, and a
  watcher removed from the box leaves its folder on the laptop; neither is handled.
- **Event delivery is crash-safe.** The event is saved as `pendingEvent` before it is sent, and a
  pending event blocks the next run: the script's cursor may already be past what it printed, so
  the same wake key is resent until the Bot has it, and only then does the script run again.
- **Revisions keep the old version running.** A change to an approved watcher becomes the pending
  version while the live one keeps running, and replaces it only after a verdict and a first run.
  Proposing the live bytes again drops the pending version.
- **The reviewer.** The server asks its text-generation model (`TextGeneration.reviewWatcher`, the
  model the thread title uses) to read the script, its purpose and `expect`, and the live version's full text to compare with,
  with the Bot's text framed as data under a random tag; a watcher that quotes the
  frame's markers is refused outright. On approval the server dry-runs the version where it will
  run and, if that completes, makes it live with `approvedBy: "reviewer"`. No user approval exists,
  and no Bot tool approves or dry-runs.
  - A rejection, a reviewer that fails or times out, and a failed dry run all
    end the same way: the pending version is discarded and the Bot is woken with the reason, framed
    as untrusted data, since a model that read a hostile script may repeat its words. A rejected
    new watcher is deleted; the log and that wake are the only record.
  - Verdicts (a bounded history that always keeps the approved ones) are shown in the user's Watchers view. The Bot's
    `t3_bot_watcher_list` returns them without reasons, for the same reason.
  - The Bot may ask for a revision of a watcher it has from any turn, but a new watcher or removal
    needs a turn the user typed (`BotService.startedByWake` decides from the run's first message: a
    `bot-wake:` message, another agent's, a scheduled task's, or one that cannot be found all count
    as not typed). After a version is dropped, a wake turn's proposals for any of that Bot's
    watchers are refused for a while, so a rejection cannot be answered by another try in a loop; a
    typed turn is exempt.
  - Reviews in flight are capped per Bot and per server, with a smaller share for wake turns, so a
    Bot cannot keep the reviewer busy. `expect` is a Bot's regex run against a script's output, so
    it runs in a short `node:vm` timer; a version whose pattern timed out stays unhealthy until it
    is replaced. The values are constants in `WatcherService`.
  - **Limits.** The reviewer is a model, so a script written to talk it into approving can succeed.
    The boundary that holds is the egress allowlist, which is not built yet (spec step 5), so until
    it is no source that needs a secret is enabled. The cooldown and the slow-pattern memory are in
    memory and reset on a restart.
- **The user can always act.** `pause`, `resume`, `remove` and moving a watcher (`setRunsOn`) are
  protected RPCs (`botWatcher.*`) the user's client calls whatever woke the Bot, and a moved watcher
  needs its first run in its new place. **Run once** (`dryRun`) refuses a pending version the
  reviewer has not approved, so a client cannot run code nobody read; an approved version, even one
  approved before the reviewer existed and so without a model verdict, always runs. Pause and remove need operate access since
  they run nothing; the others start code and need terminal access, as saving a workflow file does.
- **Watcher wakes are influenced.** A wake from a watcher (`bot-wake:watcher...`, review verdicts
  included) marks the turn it starts influenced, as a mail digest does, so
  [`BotHoldService`](../../apps/server/src/bots/BotHoldService.ts) holds consequential calls in it.
  A script's output reaches the Bot, and a script may print what a stranger wrote.
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
  with, and runs those bytes through the same private-copy path as a local run. The box holds the
  verdicts; the laptop keeps no approvals of its own. It returns the exit and output, and
  the box judges, dedupes and frames them exactly as for a local run. A peer that does not
  answer is `waiting`, not failing: nothing is counted, `failing` and its backoff stay as they
  were, and it is asked again after a minute (the link itself is kept alive by
  `PeerLinkKeepalive`). A peer that answers with a refusal is a failure like any other.

A health wake is deduplicated per failure: a trip, or new output, wakes at once, and the same
output wakes again after a delay that doubles up to a ceiling. Recovery clears the state silently.
`state.json` is saved with the wake `pending` before `BotService.wakeWith` queues it, and its key
carries the failure's start, wake count and output fingerprint, so a restart resends the same key
instead of waking twice. An `events` wake is not deduplicated, since each is news; its key carries
the run's time. Output reaches the Bot framed as untrusted data, with a random tag.
