# Claude

T3 Code drives your Claude Code installation, login, skills, and plugins. See [provider setup](./install.md#providers) for initial installation.

## Plan with Opus, build with Sonnet

**Claude Opus Planning · Sonnet** in the model picker is a policy rather than a
single model: Claude plans with Opus and does the building with Sonnet. Choose it
when you want the stronger model shaping the approach without running it for the whole
session. It needs a Claude Code version that supports `opusplan`.

The Opus half applies only while the composer is set to **Plan**. In **Build** the same
selection runs as ordinary Sonnet, and nothing in the thread marks the difference.
Planning also falls back to Sonnet once a conversation grows past roughly 200,000
tokens.

Usage limits count against whichever model a turn actually used, so a planning turn can
draw down a different limit than a build turn.

## Multiple accounts and presets

Isolate separate Claude accounts or router presets with distinct `CLAUDE_CONFIG_DIR` directories:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add a second Claude instance in **Settings → Providers** (or **Add Claude account** on mobile) pointing **CLAUDE_CONFIG_DIR path** to `~/.claude_personal` (leave empty for the default directory). Always use `CLAUDE_CONFIG_DIR` rather than `HOME` so system keychain paths stay intact.

- Existing threads can only switch between Claude instances sharing the same config directory.
- Put API keys and endpoint overrides in **Environment variables** (not **Launch arguments**).
- Paths in `--settings` and `--append-system-prompt-file` expand `~` to the server's home directory; other relative paths resolve from the thread's workspace.

## Compact long conversations

- **Auto-compact threshold**: Set **Auto-compact after** (`100000`–`1000000` tokens) in the Claude instance settings to trigger summarization earlier without changing the model's context window.
- **Manual compaction**: Send `/compact` in chat.
- **Idle compaction (>200k tokens)**: Configure **Settings → Providers → Advanced → Compact idle threads** (overridable per instance):
  - **When you return** (default): Shows a **Compact** chip next to Send once Claude's prompt cache expires (~1 hour on subscriptions, 5 min on API/Bedrock/Vertex). Click it to switch to **Keep** if you want full history.
  - **Before the cache expires (beta)**: Automatically sends `/compact` shortly before the cache expires while history is still cached (falls back to **When you return** if missed).
  - **Never**: Disables idle compaction prompts.

## Steering, usage limits, and tasks

- **Steering**: Steered messages wait until Claude finishes its active tool calls, then enter the same turn (or queue for the next turn if Claude exits or drops them).
- **Usage limits**: Mid-turn limit hits display the window and reset time; Claude holds the turn until reset, or you can stop and resume later.
- **Task lists**: Add `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the instance's **Environment → Variables** to show Claude's task list progress in web and desktop threads.
- **Auto mode**: Uses Claude Code's native auto mode (disabled if `disableAutoMode` is set in Claude's managed, user, or project settings). See [Permission modes](./permission-modes.md).

## Skills and MCP sign-in

- **Skills**: Loaded from `<CLAUDE_CONFIG_DIR>/skills`, the project's `.claude/skills` (config dir wins on name collisions), and enabled Claude plugins (e.g. `plugin:review`). Invoke via `$`. Send `disable-model-invocation` skills one per message.
- **MCP OAuth**: When a Claude MCP server needs sign-in, click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into T3 Code (**Finish sign-in**). Connectors added on `claude.ai` authenticate there instead.

## Claude Cloud (Early Access)

Claude Cloud runs a thread in Anthropic's cloud sandbox, the same one behind claude.ai/code,
instead of on your machine. The session also appears on claude.ai/code and in the Claude app.

It is off by default. Turn it on in **Settings > Providers > Claude Cloud**. It uses the login the
`claude` command saved, so it needs a Claude subscription sign-in (`claude auth login`). An API key
or a router setup does not work. If the provider card asks you to sign in, run `claude` once. T3 Code
only reads that login and never refreshes it, so run `claude` again when it expires.

When the project's remote is on GitHub, the cloud session clones that repository through the Claude
GitHub app. If the app cannot reach it, the session runs without a repository and the thread says
so. Projects with other hosts run without one.

Things that differ from a local Claude thread:

- The agent works in the sandbox, so nothing it does appears in your folder. Diffs, checkpoints,
  and revert are not available, and a worktree or checkout choice has no effect.
- It has full access inside the sandbox and never asks for permission, whatever the thread's
  permission mode.
- Messages are text only; a message with images or files is refused.
- Its usage and cost do not appear on the Usage page.

Stopping a thread, or leaving it idle, keeps the cloud session so you can continue. Deleting the
thread archives it. If the session was archived elsewhere, the next message starts a new one and
the thread says so. A reply the cloud finishes while T3 Code is closed shows on claude.ai but not in
the thread.

## Claude in Chrome

To use the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) in T3 Code threads, add `--chrome` to **Launch arguments** in the Claude instance settings (applies to new sessions). Requires a direct Anthropic `/login` plan—not supported with API keys, `setup-token`, Bedrock/Vertex, or WSL.

## OpenRouter and local routers

Create a separate Claude instance with its own config directory (e.g. `~/.claude_openrouter`, after running `/logout` if it had a cached Anthropic login) and set **Environment variables**:

| Variable               | Value                                    |
| ---------------------- | ---------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`              |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key (mark Sensitive) |
| `ANTHROPIC_API_KEY`    | Explicitly empty                         |

Add unlisted OpenRouter models via **Add custom model** in the instance settings. See the [OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) or [Claude Code Router](https://github.com/musistudio/claude-code-router) for local router setup.
