import type { EnvironmentId, ProviderMcpServer, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Plug, RefreshCw } from "lucide-react";
import { useCallback } from "react";

import { mcpEnvironment } from "../state/mcp";
import { useAtomCommand } from "../state/use-atom-command";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../state/query";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { cn } from "../lib/utils";

/**
 * MCP servers of the open thread's session.
 *
 * Scoped to the thread because the connections are: the CLI reads MCP config
 * when it spawns, so two threads can honestly disagree about a server's state.
 * Reconnect and disable act on this session alone — nothing here edits the
 * files the servers are configured in.
 */

const STATE_LABEL: Record<ProviderMcpServer["state"], string> = {
  connected: "Connected",
  failed: "Failed",
  "needs-auth": "Needs sign-in",
  pending: "Connecting",
  disabled: "Disabled",
};

const STATE_CLASS: Record<ProviderMcpServer["state"], string> = {
  connected: "text-emerald-500",
  failed: "text-destructive-foreground",
  "needs-auth": "text-amber-500",
  pending: "text-secondary-label",
  disabled: "text-secondary-label",
};

/**
 * Reconnect cannot sign a server in — the SDK throws on a `needs-auth` server
 * rather than starting an OAuth flow, so the button alone would be a promise
 * the panel cannot keep. Signing in happens in Claude Code; reconnect is what
 * picks the result up afterwards.
 */
const NEEDS_AUTH_HINT = "Sign in to this server in Claude Code, then reconnect to pick it up.";

export function McpPanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  const { environmentId, threadId } = props;
  const query = useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : mcpEnvironment.list({ environmentId, input: { threadId } }),
  );
  const reconnect = useAtomCommand(mcpEnvironment.reconnect, "mcp reconnect");
  const setEnabled = useAtomCommand(mcpEnvironment.setEnabled, "mcp set enabled");

  // Without this the repair actions fail silently: a failed command only ever
  // reaches console.warn, and a server that refuses to reconnect looks
  // identical to one the button never reached.
  const report = useCallback(
    async (title: string, run: Promise<AsyncResult.AsyncResult<unknown, unknown>>) => {
      const result = await run;
      if (result._tag !== "Failure") return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: formatEnvironmentQueryError(result.cause),
        }),
      );
    },
    [],
  );

  if (environmentId === null || threadId === null) {
    return <PanelMessage>Open a thread to see its MCP servers.</PanelMessage>;
  }
  if (query.data === null) {
    return (
      <PanelMessage>
        {query.error ?? (query.isPending ? "Loading…" : "Could not read MCP servers.")}
      </PanelMessage>
    );
  }

  // Distinct from an empty list: the provider has no MCP control at all, or the
  // thread has no running session yet. Saying so beats an empty panel that
  // reads like a session with no servers configured.
  if (!query.data.supported) {
    return (
      <PanelMessage>
        MCP management is available on Claude threads with a running session. Send a message to
        start one.
      </PanelMessage>
    );
  }
  if (query.data.servers.length === 0) {
    return <PanelMessage>This session has no MCP servers configured.</PanelMessage>;
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2 p-2">
        {query.data.servers.map((server) => (
          <div key={server.name} className="rounded-lg border border-border/60 p-2">
            <div className="flex items-center gap-2">
              <Plug aria-hidden className="size-3 shrink-0 text-secondary-label" />
              <span className="min-w-0 truncate text-sm font-medium">{server.name}</span>
              <span className={cn("ml-auto shrink-0 text-xs", STATE_CLASS[server.state])}>
                {STATE_LABEL[server.state]}
              </span>
            </div>

            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-secondary-label">
              {server.scope ? <span>{server.scope}</span> : null}
              {server.version ? <span>v{server.version}</span> : null}
              {server.url ? <span className="truncate">{server.url}</span> : null}
            </div>

            {/* The server's own words. A generic failure message would hide the
                one thing that says what to fix. */}
            {server.error ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-destructive-foreground">
                {server.error}
              </p>
            ) : null}

            {server.state === "needs-auth" ? (
              <p className="mt-1 text-[11px] text-secondary-label">{NEEDS_AUTH_HINT}</p>
            ) : null}

            <div className="mt-1.5 flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  void report(
                    `Could not reconnect ${server.name}`,
                    reconnect({ environmentId, input: { threadId, serverName: server.name } }),
                  );
                }}
              >
                <RefreshCw aria-hidden className="size-3" />
                Reconnect
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  const enabled = server.state === "disabled";
                  void report(
                    `Could not ${enabled ? "enable" : "disable"} ${server.name}`,
                    setEnabled({
                      environmentId,
                      input: { threadId, serverName: server.name, enabled },
                    }),
                  );
                }}
              >
                {server.state === "disabled" ? "Enable" : "Disable"}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function PanelMessage(props: { readonly children: React.ReactNode }) {
  return <p className="p-3 text-xs text-muted-foreground">{props.children}</p>;
}
