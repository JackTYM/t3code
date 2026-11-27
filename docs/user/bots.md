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
  the Bot reads your change on its next turn. Its **Watchers and tools** tab lists the scripts the
  Bot writes: watchers, which check something on a timer and wake the Bot only when it changes, and
  [tools](#secrets-and-tools), which the Bot calls when it wants to look something up. You do not
  approve them: a reviewer model reads each script first, and a script it rejects never runs. Each
  row shows whether it is a watcher or a tool, its verdict, what it is for and, for a watcher, where
  it runs. **Pause** and **Resume** appear once a version is approved, and **Remove** is always
  there; removing or pausing a tool makes the watchers that use it fail, and the tool's row lists
  them. To move a watcher to a linked environment, pick the place under **Runs on**, press **Run
  once there** to see what it prints, then **Move**; a watcher cannot be moved while a new version
  is under review, and a tool, or a watcher that uses secrets or tools, always runs on this
  machine. To change a script, use **Ask the Bot to revise**; you cannot edit it yourself. A watcher
  on a linked environment shows **waiting** while that environment does not answer. The reviewer
  uses your text-generation model, so if it cannot run, choose another in Settings. A count on the
  **Bot** button shows how many watchers or tools are failing or broken and how many calls the Bot
  holds for you; it updates when you return to the window, close the popover or the Bot finishes a
  turn.
- A Bot can switch itself to a stronger model for a task that needs more reasoning; when that turn
  ends, T3 Code puts it back on the model it was on, unless you changed the model yourself in the
  meantime. A server restart in between leaves it on the stronger one.
- Settle or archive a Bot when you are done: its crew go back to the top of the sidebar and it stops
  being woken. Reopen it to take them back.

## Secrets and tools

A Bot can read things that need a login, such as your mail, an issue tracker or a calendar,
through a script that uses a secret you gave it. You decide which secrets it gets:

- In **Settings → Home**, open **Bot secret grants**, choose the Bot and press **Add grant**. Give
  the secret a name in capitals, such as `GITHUB_TOKEN`, the hosts it may be sent to, and its value
  (at least 8 characters), or pick a reference to a secret in your password manager.
- No screen or tool shows the Bot a grant's value, only its name and hosts. Stored values are
  plain files in the `secrets` folder of the server's data. A script you approved runs in a
  sandbox that cannot open that folder (macOS; on another system a script that uses a secret does
  not run). The Bot's own shell and its crews run as you and can open it if something steered
  them to look; the Bot is told not to, and nothing enforces that. A script gets a secret only if
  it names it, and only when it runs on this machine. Anything the script prints has the value
  replaced by `[secret NAME]`.
- Hosts are shown to the reviewer model, but nothing yet stops a script from sending a secret
  elsewhere, and a model alone judges every new version of a script that uses one.
- **Do not grant a credential whose misuse you could not accept.** Until the Bot and its crews are kept
  from that folder and requests are held to the listed hosts, give only tokens limited to
  read access, and rotate one you doubt.
- Remove a grant to take the secret back. A row in the **Watchers and tools** tab marks a secret
  that still needs a grant.

A **tool** is a read-only script the Bot calls when it wants an answer, with arguments, for
example "what is open on this repository". It gets the same review as a watcher and appears in the
same tab, marked as a tool. A watcher can also use a tool: T3 Code runs it first and hands the
watcher what it printed, so the watcher itself never holds the secret.

What a tool or watcher prints can contain text from outside sources, such as the subject of an
email or an issue title, and anyone can write that text. The Bot treats it as information, not as
instructions, and once it has called a tool in a turn, actions that reach beyond its notes and
crew wait for your approval, as they do after an email.

## Self-repair

When something in how a Bot runs keeps failing (a watcher, the model that reviews watchers, or a
Bot run that ends in failure), T3 Code tells the Bot, and the Bot can start a coding crew that fixes
T3 Code itself. The crew works in a separate checkout on a new branch, opens a pull request, waits
for its checks and, when they all pass, merges it. If a repair fails twice, the Bot tells you it
needs you.

- **Nothing repairs until you choose a Repair project** in **Settings → Home**: a checkout of T3
  Code itself. To turn self-repair off, set it back to **None**.
- The crew is told not to build, install or release anything, and it merges through a tool that
  T3 Code checks. That is all that holds it: the crew gets your Bot's access, which on full access
  is a shell with your own logins, so "do not build or release" is an instruction it follows, not a
  block.
- T3 Code refuses the crew's merge, and the fix waits for you as an open pull request, when it
  touches the parts that guard the Bot (its own safety machinery, how the server connects, starts and
  answers requests, what it runs and reaches, how it updates and releases, CI and scripts,
  dependencies, the desktop updater and signing) or when any of its checks has not passed. A pull
  request with no checks counts as not passed. The web and mobile apps, and most of the other
  packages, are not on that list: a fix there merges when its checks pass. This is a check on the
  merge tool only: a crew that merges another way, through its shell, is not stopped by it.
- Automatic merging needs the repository's checks to run on pull requests. Without that, every
  fix waits for you.

For a hard limit that does not depend on the crew following its instructions, turn on branch
protection for the default branch on GitHub, requiring a pull request and its checks, and keep
secrets out of workflows that run on pull requests: a pull request from the repository itself runs
its own edited workflows as soon as it is pushed.

## Email

A Bot can follow your email. Mail from your accounts is forwarded by a Cloudflare mail Worker to a
hook that T3 Code makes for the Bot. Set it all up in the **Mail** tab of the **Bot** button, top to
bottom:

1. **Mail hook.** Choose **Create the mail hook**. It shows the address and signing secret once, with
   copy buttons; set them as `BOX_URL` and `WEBHOOK_SECRET` on your mail Worker. The secret is not
   shown again, and closing the popover hides it too. If the hook has no public address, T3 Connect
   is off and the Worker cannot reach it until you turn it on. **Rotate secret** replaces the secret:
   mail signed with the old one is refused at once until the Worker has the new one. The tab also
   shows whether the hook is on and signed, and how the last delivery ended.
2. **Mailboxes.** Add each of your own addresses exactly as mail arrives at it (your Worker's
   `MAILBOXES` must list the same ones), then **Save**. The same section sets how many days mail is
   kept and how often the Bot may be told about new mail, and shows how much is kept per address. The
   top of the tab counts what is stored, how much of it is bulk, and how much was dropped. Mail sent
   to an address that is not on your list is dropped and counted; the section lists the latest few
   such addresses (Apple's Hide My Email addresses show up here) with **Add to my addresses**, and
   **Clear** resets the count.
3. **History import.** See [Importing mail from your Mac](#importing-mail-from-your-mac).

The Bot is told about new mail in a short digest
(sender, subject, and whether the sender's domain was verified, never the text), at most once every
few minutes, and can search for emails by sender and subject. Newsletters, marketing and automated
mail (judged from the sender's own headers) are still stored and searchable, but never wake the Bot;
a digest only says how many were stored, and the Bot looks for them when asked. It cannot send,
delete or archive anything.

The Bot never reads an email's text itself. When it needs one, it starts a mail reader: a helper
that can only read, with no way to run a command, change a file or reach anything else, so it
starts without asking you. The Bot acts only on the short summary that comes back, by adding to its
task list. Even so, treat that summary as information, not as a command: anyone can send you an
email that tries to give your Bot orders, and the reader's summary can be steered too.

When outside content started or shaped what the Bot is doing (an email, or the output of a watcher or tool), it can still read, take notes and add tasks,
but anything that could act on the world waits for you: starting a thread or helper, messaging a
thread that is not its own crew, scheduling something or touching a linked environment. Those
appear at the top of the **Bot** popover with what the Bot asked for; **Allow** lets the Bot do
exactly that, **Reject** tells it not to. Held requests are kept only until the server restarts.

The Bot keeps mail only for the addresses you list in the **Mail** tab, so nothing is stored until
you add them. Each address is one of your own, such as a Gmail account. It keeps mail for 90 days by
default. Mail already in the Mac Mail app on a linked laptop can be pulled in as history; that does
not wake the Bot, and a laptop that is asleep just makes the pull wait.

## Importing mail from your Mac

In the **Mail** tab, choose the linked Mac and 30, 60 or 90 days, then **Import history**. The tab
shows whether the import is running, waiting, failed (with the reason) or done, and how many emails
it kept; it does not update by itself, so press refresh to see progress. The link must be paired
with full access. macOS keeps Mail's folder private, so on that
Mac open **System Settings → Privacy & Security → Full Disk Access**, turn it on for the app that
runs the T3 Code server (the T3 Code app, or the terminal app if you started it with `npx t3`), then
quit and reopen that app. Until you do, the import stops with a message naming this step. Only
inbound mail is read: Sent, Drafts, Junk and Trash are skipped. A Mail account whose address cannot be
worked out is kept only if you allow its placeholder address (`...@mail-app.invalid`), which the
tab lists as an unknown account with how many messages it saw, with an **Allow** button that adds
that exact address.
