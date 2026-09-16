import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  buildMessagesTimelineSearchIndex,
  findMessagesTimelineMatches,
  initialMessagesTimelineMatch,
  messagesTimelineFindStatus,
  stepMessagesTimelineMatch,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

/** Matches the minimap jump so a match lands clear of the top fade. */
const FIND_SCROLL_VIEW_OFFSET = 24;
const FIND_TARGET_CLASS = "timeline-find-target";

function clearFindTarget(viewport: HTMLElement | null) {
  viewport
    ?.querySelectorAll(`.${FIND_TARGET_CLASS}`)
    .forEach((element) => element.classList.remove(FIND_TARGET_CLASS));
}

export interface TimelineFindBarProps {
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly listRef: React.RefObject<LegendListRef | null>;
  readonly viewport: HTMLElement | null;
  /** Breaks live-follow so a streaming edge cannot yank the reader off a match. */
  readonly onManualNavigation: () => void;
  readonly onClose: () => void;
}

/**
 * Find within the loaded transcript.
 *
 * The query lives here rather than in `MessagesTimeline` on purpose: this
 * component renders no timeline rows, so typing repaints the bar alone. The
 * match flash is applied straight to the row element by class name for the same
 * reason — routing it through `TimelineRowCtx` would re-render every mounted row
 * on each keystroke.
 */
export function TimelineFindBar({
  rows,
  listRef,
  viewport,
  onManualNavigation,
  onClose,
}: TimelineFindBarProps) {
  const [find, setFind] = useState<{
    readonly query: string;
    readonly matches: ReadonlyArray<number>;
    readonly position: number;
  }>({ query: "", matches: [], position: 0 });
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Where the reader was when this query started, so a new query lands forward
  // of their position rather than jumping to the top of the thread.
  const anchorRowIndexRef = useRef(0);

  // Rebuilt when the rows change, not when the query does.
  const searchIndex = useMemo(() => buildMessagesTimelineSearchIndex(rows), [rows]);

  const revealRow = useCallback(
    (rowIndex: number) => {
      anchorRowIndexRef.current = rowIndex;
      const rowId = rows[rowIndex]?.id;
      onManualNavigation();
      void listRef.current
        ?.scrollToIndex({ index: rowIndex, animated: true, viewOffset: FIND_SCROLL_VIEW_OFFSET })
        .then(() => {
          // The row only exists in the DOM once the virtualizer has placed it.
          requestAnimationFrame(() => {
            clearFindTarget(viewport);
            if (rowId === undefined) return;
            viewport
              ?.querySelector(`[data-timeline-row-id="${CSS.escape(rowId)}"]`)
              ?.classList.add(FIND_TARGET_CLASS);
          });
        });
    },
    [listRef, onManualNavigation, rows, viewport],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Drop the flash when the bar unmounts; closing must leave the scroll alone.
  useEffect(() => () => clearFindTarget(viewport), [viewport]);

  const runQuery = useCallback(
    (query: string) => {
      const matches = findMessagesTimelineMatches(searchIndex, query);
      const position = initialMessagesTimelineMatch(matches, anchorRowIndexRef.current);
      setFind({ query, matches, position });
      const rowIndex = matches[position];
      if (rowIndex === undefined) {
        clearFindTarget(viewport);
        return;
      }
      revealRow(rowIndex);
    },
    [revealRow, searchIndex, viewport],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      if (find.matches.length === 0) return;
      const position = stepMessagesTimelineMatch(find.matches.length, find.position, direction);
      setFind({ ...find, position });
      revealRow(find.matches[position]!);
    },
    [find, revealRow],
  );

  const status = messagesTimelineFindStatus(find.query, find.matches.length, find.position);
  const hasMatches = find.matches.length > 0;

  return (
    <div
      className="-translate-x-1/2 absolute top-2 left-1/2 z-50 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg border border-border bg-popover px-1.5 py-1 shadow-md"
      data-timeline-find-bar="true"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          // Other Escape handlers dismiss citations and panels; this one is ours.
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <Input
        ref={inputRef}
        nativeInput
        size="compact"
        className="w-44 border-none bg-transparent shadow-none"
        placeholder="Find in thread"
        aria-label="Find in thread"
        value={find.query}
        onChange={(event) => runQuery(event.target.value)}
      />
      <span
        className="min-w-16 shrink-0 text-right text-muted-foreground text-xs tabular-nums"
        aria-live="polite"
      >
        {status}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={!hasMatches}
        onClick={() => step(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={!hasMatches}
        onClick={() => step(1)}
      >
        <ChevronDownIcon />
      </Button>
      <span className="shrink-0 border-border border-l pl-2 text-[11px] text-muted-foreground">
        Loaded messages only
      </span>
      <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={onClose}>
        <XIcon />
      </Button>
    </div>
  );
}
