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
- Memory is `<base>/bots/<folder>/notes.md` and `preferences.md`. Every Home shares the `home`
  folder, so its memory survives Start fresh; other Bots own theirs. These files are user-owned and
  never rewritten by the server.
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

## Watchers

A watcher is a script that polls for free and wakes the Bot, a model call, only when it trips.
[`WatcherService`](../../apps/server/src/bots/WatcherService.ts) registers one pass with the
`Scheduler`; each watcher is a folder `<base>/bots/<folder>/watchers/<name>/` with a `run`
executable and a `watcher.json`. The Bot writes both, so a watcher runs only while the sha256 of
`run` and `watcher.json` (minus `approvedHash`) equals `approvedHash`. An edit, by anyone, voids
the approval until it is renewed. Healthy is exit 0 with stdout matching `expect`, if set.

A wake is deduplicated per failure: a trip, or new output, wakes at once, and the same output
wakes again after 15 minutes, doubling up to 24 hours. Recovery clears the state silently.
`state.json` is saved with the wake `pending` before `BotService.wakeWith` queues it, and its key
carries the failure's start, wake count and output fingerprint, so a restart resends the same key
instead of waking twice. The output reaches the Bot framed as untrusted data, with a random tag.
The script runs with a minimal environment and a cap on its output.
