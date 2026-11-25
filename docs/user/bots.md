# Bots and Home

A Bot is a conversation that coordinates instead of coding. It starts threads for the work, follows
them, and keeps notes. The threads it starts are its crew and show under it in the sidebar. Home is
the Bot for everything: one per environment, across all your projects and linked environments.

## Home

Open **Home** at the top of the sidebar (or press `⌘⇧0`, `Ctrl+Shift+0` on Windows and Linux) and
choose **Enable Home**. Pick its model in **Settings → Home**; without one, Home uses the
environment's default model. **Start fresh** gives Home a new conversation; its notes, preferences
and crew carry over. Home always starts work in a real project or a scratch folder. Turning Home off
stops its current turn.

## Starting a Bot

In a thread's menu or the command palette, choose **Start a Bot from this thread**. A new Bot starts
in the same project with a summary of the thread, and that thread becomes its first crew member.

## Working with a Bot

- When a crew thread finishes or needs your approval, the Bot is told and can follow up. Ask it to
  watch other threads or workflow runs too.
- The **Bot** button in its header shows its notes and preferences, which you can edit, and can mute
  crew notifications other than requests for input. Its **Tasks** tab lists what the Bot is
  tracking and which threads work on each. Tick a task to mark it done and untick it to reopen it;
  the Bot reads your change on its next turn. Its **Watchers** tab lists the scripts the Bot
  writes to watch things for free and wake it when something changes. Nothing runs until you
  approve: read the source (and the diff from the version you approved), choose where it runs, press
  **Run once** to see its output, then **Approve this version**. If the Bot changes a script it stops
  until you approve the new version or reject it, which keeps the approved one. To change a script,
  use **Ask the Bot to revise**; you cannot edit it yourself. **Pause**, **Resume** and **Remove**
  work any time. A watcher on a linked environment shows **waiting** while that environment does
  not answer, and moving one needs a **Run once** there first.
  A count on the **Bot** button shows how many watchers need you; it updates when you return to the
  window, close the popover or the Bot finishes a turn.
- Settle or archive a Bot when you are done: its crew go back to the top of the sidebar and it stops
  being woken. Reopen it to take them back.

## Email

A Bot can follow your email. Mail from your accounts is forwarded to an address you set up, and the
Bot reads it only when it needs to: it is told about new mail in a short digest (sender, subject,
and whether the sender's domain was verified, never the text), at most once every few minutes, and
can open an email or search through them. It cannot send, delete or archive anything, and it
writes follow-ups to its task list rather than acting. Treat the Bot's summary of an email as
information, not as a command: anyone can send you an email that tries to give your Bot orders.

The Bot keeps mail only for the addresses you choose, so nothing is stored until you pick them
(there is no screen for this yet). Each address is one of your own, such as a Gmail account. It keeps
mail for 90 days by default, and you can forget a single email: only that you forgot it is kept.
Mail already in the Mac Mail app on a linked laptop can be pulled in as history; that does not wake
the Bot, and a laptop that is asleep just makes the pull wait.

## Importing mail from your Mac

A Bot that keeps your mail can import the last 30 to 90 days from the Mail app on a Mac linked to its
environment. The link must be paired with full access. macOS keeps Mail's folder private, so on that
Mac open **System Settings → Privacy & Security → Full Disk Access**, turn it on for the app that
runs the T3 Code server (the T3 Code app, or the terminal app if you started it with `npx t3`), then
quit and reopen that app. Until you do, the import stops with a message naming this step. Only
inbound mail is read: Sent, Drafts, Junk and Trash are skipped.
