import {
  EnvironmentId,
  OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface EnvironmentThreadSearchMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSearchResultsState {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isLoading: boolean;
}

const ThreadSearchKey = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Array(EnvironmentId),
    OrchestrationSearchThreadsInput.fields.query,
    Schema.Boolean,
  ]),
);
const decodeThreadSearchKey = Schema.decodeUnknownOption(ThreadSearchKey);

/**
 * `includeActivityMatches` is part of the key, not just the request, because
 * the two surfaces want different answers to the same words. The thread
 * switcher only renders message matches, so a thread whose sole hit is a tool
 * call would disappear from it; the sidebar wants exactly those hits. Sharing
 * one atom between them would hand whichever asked first to the other.
 */
export function makeThreadSearchKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
  includeActivityMatches = false,
): string {
  return JSON.stringify([
    [...environmentIds].sort((left, right) => left.localeCompare(right)),
    query,
    includeActivityMatches,
  ]);
}

function parseThreadSearchKey(key: string) {
  return decodeThreadSearchKey(key);
}

export function threadSearchMatchKey(
  match: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">,
): string {
  return JSON.stringify([match.environmentId, match.threadId]);
}

/**
 * Combines one search query atom per environment. Invalid search keys, failed
 * requests, and disconnected environments contribute no content matches,
 * preserving local title search as the compatibility fallback.
 */
export function createThreadSearchResultsAtomFamily<E>(options: {
  readonly getSearchAtom: (
    environmentId: EnvironmentId,
    query: string,
    includeActivityMatches: boolean,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationSearchThreadsResult, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const parsedKey = parseThreadSearchKey(key);
      if (Option.isNone(parsedKey)) {
        return { matches: [], isLoading: false };
      }

      const [environmentIds, query, includeActivityMatches] = parsedKey.value;
      const matches: EnvironmentThreadSearchMatch[] = [];
      let isLoading = false;

      for (const environmentId of environmentIds) {
        const result = get(options.getSearchAtom(environmentId, query, includeActivityMatches));
        isLoading ||= result.waiting;
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) {
          matches.push(
            ...value.matches.map((match) => ({
              ...match,
              environmentId,
            })),
          );
        }
      }

      return { matches, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${key}`)),
  );
}
