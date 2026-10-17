import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, McpServerStatus, ThreadId } from "@t3tools/contracts";
import type { AsyncResult } from "effect/reactivity";
import { PlugIcon, RefreshCwIcon } from "lucide-react";
import { useCallback } from "react";

import { mcpServerEnvironment } from "../../state/mcpServers";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  MCP_NEEDS_AUTH_HINT,
  MCP_SERVER_STATE_BADGE,
  MCP_SERVER_STATE_LABEL,
  mcpServerActions,
  mcpServersUnavailableCopy,
} from "./McpServersPanel.logic";

/**
 * The MCP servers of the thread's live provider session. Repairs act on that
 * session alone; nothing here edits the files the servers are configured in.
 */
export function McpServersPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const query = useEnvironmentQuery(
    mcpServerEnvironment.list({ environmentId, input: { threadId } }),
  );
  const canRepair = useAtomValue(mcpServerEnvironment.reconnect.permissionAtom(environmentId));
  const reconnect = useAtomCommand(mcpServerEnvironment.reconnect, { reportFailure: false });
  const setEnabled = useAtomCommand(mcpServerEnvironment.setEnabled, { reportFailure: false });

  // A failed repair must say so: a server that refused looks identical to one
  // the button never reached otherwise.
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

  const list = query.data;
  if (list === null) {
    return (
      <PanelState
        title={query.error === null ? "Loading MCP servers" : "Could not read MCP servers"}
        description={query.error ?? "Asking the session…"}
        onRefresh={query.error === null ? undefined : query.refresh}
        refreshing={query.isPending}
      />
    );
  }
  if (list.status === "unavailable") {
    return (
      <PanelState
        {...mcpServersUnavailableCopy(list.reason)}
        onRefresh={query.refresh}
        refreshing={query.isPending}
      />
    );
  }
  if (list.servers.length === 0) {
    return (
      <PanelState
        title="No MCP servers"
        description="This session has no MCP servers configured."
        onRefresh={query.refresh}
        refreshing={query.isPending}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end px-2 pt-2">
        <Button
          size="micro"
          variant="ghost-muted"
          onClick={query.refresh}
          disabled={query.isPending}
          aria-busy={query.isPending}
        >
          <RefreshIcon refreshing={query.isPending} />
          Refresh
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2 p-2">
          {list.servers.map((server) => (
            <McpServerRow
              key={server.name}
              server={server}
              canRepair={canRepair}
              onReconnect={() =>
                void report(
                  `Could not reconnect ${server.name}`,
                  reconnect({ environmentId, input: { threadId, server: server.name } }),
                )
              }
              onToggle={(enabled) =>
                void report(
                  `Could not ${enabled ? "enable" : "disable"} ${server.name}`,
                  setEnabled({ environmentId, input: { threadId, server: server.name, enabled } }),
                )
              }
            />
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}

function McpServerRow(props: {
  readonly server: McpServerStatus;
  readonly canRepair: boolean;
  readonly onReconnect: () => void;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const { server } = props;
  const actions = mcpServerActions(server);
  const details = [server.scope, server.version && `v${server.version}`, server.host].filter(
    (detail): detail is string => typeof detail === "string" && detail.length > 0,
  );
  return (
    <li className="rounded-lg border border-border/60 p-2">
      <div className="flex min-w-0 items-center gap-2">
        <PlugIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{server.name}</span>
        <Badge variant={MCP_SERVER_STATE_BADGE[server.state]} size="sm">
          {MCP_SERVER_STATE_LABEL[server.state]}
        </Badge>
      </div>
      {details.length > 0 ? (
        <p className="mt-0.5 truncate text-muted-foreground text-xs">{details.join(" · ")}</p>
      ) : null}
      {/* The server's own words: usually the one thing that says what to fix. */}
      {server.error ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-destructive-foreground text-xs">
          {server.error}
        </p>
      ) : null}
      {server.state === "needs-auth" ? (
        <p className="mt-1 text-muted-foreground text-xs">{MCP_NEEDS_AUTH_HINT}</p>
      ) : null}
      {props.canRepair && (actions.reconnect || actions.toggle !== null) ? (
        <div className="mt-1.5 flex items-center gap-1">
          {actions.reconnect ? (
            <Button size="micro" variant="ghost" onClick={props.onReconnect}>
              <RefreshCwIcon aria-hidden />
              Reconnect
            </Button>
          ) : null}
          {actions.toggle !== null ? (
            <Button
              size="micro"
              variant="ghost-muted"
              onClick={() => props.onToggle(actions.toggle === "enable")}
            >
              {actions.toggle === "enable" ? "Enable" : "Disable"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function PanelState(props: {
  readonly title: string;
  readonly description: string;
  readonly onRefresh: (() => void) | undefined;
  readonly refreshing: boolean;
}) {
  return (
    <Empty size="compact">
      <EmptyMedia variant="icon">
        <PlugIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.onRefresh ? (
        <Button
          size="sm"
          variant="outline"
          onClick={props.onRefresh}
          disabled={props.refreshing}
          aria-busy={props.refreshing}
        >
          <RefreshIcon size="sm" refreshing={props.refreshing} />
          Refresh
        </Button>
      ) : null}
    </Empty>
  );
}
