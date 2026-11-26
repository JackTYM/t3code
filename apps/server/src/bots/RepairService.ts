import { type MilestoneEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as PayloadSigner from "../auth/PayloadSigner.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BotService from "./BotService.ts";

// A health wake holds fixed fields only and `BotHoldService` deliberately does not count it as
// influenced: `bot-wake:health:` matches neither the mail nor the watcher prefix. Nothing a
// stranger could have written (script output, a reviewer's reason, a purpose) may reach `healthText`.
const HEALTH_MESSAGE_PREFIX = "bot-wake:health:";
const FIRST_BACKOFF_MS = 60 * 60_000;
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
const MAX_EPISODES = 100;
// What a name may be, by kind. No whitespace, quotes, brackets or newlines: a name cannot carry a
// sentence. A watcher's name is validated the same way when it is proposed; a run id is
// `run:thread:<encoded thread id>:ordinal:<n>`.
const WATCHER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:%~-]{0,255}$/u;
const LATEST_TIME_MS = Date.UTC(9999, 11, 31);

const Kind = Schema.Literals(["watcher", "reviewer", "run"]);
type Kind = typeof Kind.Type;

/**
 * One failure of one thing, from its first report until it recovers. `pending` is the wake saved
 * before it is queued and removed after, so a restart resends it under the same key. The file is
 * signed with a key a Bot and a script cannot read.
 */
const Episode = Schema.Struct({
  /** What a repair names, and part of every wake key of the episode. */
  id: Schema.String,
  kind: Kind,
  botThreadId: ThreadId,
  name: Schema.String,
  count: Schema.Int,
  firstAt: Schema.Number,
  lastAt: Schema.Number,
  wakes: Schema.Int,
  /** Doublings of the backoff so far. */
  step: Schema.Int,
  nextWakeAt: Schema.Number,
  pending: Schema.optional(Schema.Struct({ key: Schema.String, text: Schema.String })),
});
type Episode = typeof Episode.Type;
type Episodes = Readonly<Record<string, Episode>>;

// `data` stays the exact text that was signed, so the signature is checked over what was read.
const SignedFile = Schema.fromJsonString(
  Schema.Struct({ data: Schema.String, signature: Schema.String }),
);
const EpisodesJson = Schema.fromJsonString(Schema.Record(Schema.String, Episode));
const decodeSignedFile = Schema.decodeEffect(SignedFile);
const encodeSignedFile = Schema.encodeEffect(SignedFile);
const decodeEpisodes = Schema.decodeEffect(EpisodesJson);
const encodeEpisodes = Schema.encodeEffect(EpisodesJson);

const backoff = (step: number) => Math.min(FIRST_BACKOFF_MS * 2 ** step, MAX_BACKOFF_MS);
const isTime = (ms: number) => Number.isSafeInteger(ms) && ms >= 0 && ms <= LATEST_TIME_MS;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const HEADLINES = {
  watcher: "a watcher keeps failing.",
  reviewer: "the watcher reviewer keeps failing to run.",
  run: "a Bot run ended in failure.",
} as const satisfies Record<Kind, string>;
const EVIDENCE_PREFIXES = {
  watcher: "watcher",
  reviewer: "watcher-review",
  run: "run",
} as const satisfies Record<Kind, string>;

/** The wake. Every value is a number, an ISO time, a hex id, a literal, or a name checked above. */
const healthText = (episode: Episode) =>
  [
    `Health signal ${episode.id}: ${HEADLINES[episode.kind]}`,
    `kind: ${episode.kind}`,
    `name: ${episode.name}`,
    `failures: ${episode.count}`,
    `first: ${iso(episode.firstAt)}`,
    `last: ${iso(episode.lastAt)}`,
    `evidence: ${EVIDENCE_PREFIXES[episode.kind]}:${episode.name}`,
    `wake: ${episode.wakes}`,
    "This message was written by the server from fixed fields. It holds no output from any script, reviewer or outside source.",
  ].join("\n");

/** A failure's identity. A reviewer's is the Bot's, whatever watcher it last failed on. */
const subjectKey = (subject: {
  readonly kind: Kind;
  readonly botThreadId: ThreadId;
  readonly name: string;
}) =>
  JSON.stringify([
    subject.kind,
    subject.botThreadId,
    subject.kind === "reviewer" ? "" : subject.name,
  ]);

export class RepairService extends Context.Service<
  RepairService,
  {
    /**
     * Tells a Bot something in how it runs keeps failing. The first report wakes it at once, later
     * ones after 1 hour, then twice as long up to 24. A `name` that is not plain is refused; the
     * wake holds these fields and nothing else.
     */
    readonly signal: (input: {
      readonly kind: Kind;
      readonly botThreadId: ThreadId;
      readonly name: string;
      readonly count: number;
      readonly firstAt: number;
      readonly lastAt: number;
    }) => Effect.Effect<void>;
    /** The failure `signal` reported is over, so the next one is news at once. */
    readonly clear: (subject: {
      readonly kind: Kind;
      readonly botThreadId: ThreadId;
      readonly name: string;
    }) => Effect.Effect<void>;
    /** Signals a failed run of a Bot, one per run. */
    readonly handleMilestone: (event: MilestoneEvent) => Effect.Effect<void>;
    /** Sends the wakes that were saved but never queued when the server last stopped. */
    readonly start: () => Effect.Effect<void>;
  }
>()("t3/bots/RepairService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const bots = yield* BotService.BotService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const signer = yield* PayloadSigner.make("repair-state-key");
  const statePath = path.join(config.stateDir, "repair-state.json");
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const newId = random.uuidV4().pipe(
    Effect.map((uuid) => uuid.replaceAll("-", "").slice(0, 12)),
    Effect.orDie,
  );

  // Read once at start, like the watchers' approvals: every change is saved before it is used.
  const initial = yield* fileSystem.readFileString(statePath).pipe(
    Effect.flatMap(decodeSignedFile),
    Effect.flatMap(({ data, signature }) =>
      signer.verify(data, signature).pipe(
        Effect.filterOrFail(
          (valid) => valid,
          () => "signature" as const,
        ),
        Effect.andThen(decodeEpisodes(data)),
      ),
    ),
    // No file yet is the usual first run. A file that cannot be vouched for is dropped whole.
    Effect.catch((cause): Effect.Effect<Episodes> =>
      Predicate.isTagged(cause, "PlatformError") && cause.reason._tag === "NotFound"
        ? Effect.succeed({})
        : Effect.logWarning(
            "Repair state failed verification or could not be read; starting without it.",
            {
              cause,
            },
          ).pipe(Effect.as({})),
    ),
  );
  const episodes = yield* Ref.make<Episodes>(initial);

  /** Saves `next` and makes it the state; false when it could not be saved. */
  const save = Effect.fn("RepairService.save")(
    function* (next: Episodes) {
      const data = yield* encodeEpisodes(next);
      const signature = yield* signer.sign(data);
      const text = yield* encodeSignedFile({ data, signature });
      // Renamed into place, so a crash cannot leave a half-written file that reads as no state.
      const temporary = `${statePath}.tmp`;
      yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 });
      yield* fileSystem.rename(temporary, statePath);
      yield* Ref.set(episodes, next);
      return true;
    },
    // Uninterruptible: a stop between the rename and the Ref must not leave the file ahead of memory.
    Effect.uninterruptible,
    Effect.catchCause((cause) =>
      Effect.logWarning("Repair state could not be saved.", { cause }).pipe(Effect.as(false)),
    ),
  );

  /** Without episodes nobody has reported for a day past their due time, and beyond the newest few. */
  const sweep = (all: Episodes, now: number): Episodes =>
    Object.fromEntries(
      Object.entries(all)
        .filter(([, episode]) => now <= episode.nextWakeAt + MAX_BACKOFF_MS)
        .sort(([, a], [, b]) => a.nextWakeAt - b.nextWakeAt)
        .slice(-MAX_EPISODES),
    );

  /** Queues the saved wake; once the Bot has it, the episode no longer owes it. */
  const send = Effect.fn("RepairService.send")(function* (
    key: string,
    episode: Episode,
    botThreadId: ThreadId,
  ) {
    if (episode.pending === undefined) return;
    if (!(yield* bots.wakeWith({ botThreadId, ...episode.pending }))) return;
    const { pending: _queued, ...settled } = episode;
    yield* save({ ...(yield* Ref.get(episodes)), [key]: settled });
  });

  const signal: RepairService["Service"]["signal"] = Effect.fn("RepairService.signal")(function* (
    input,
  ) {
    const { kind, botThreadId, name, count, firstAt, lastAt } = input;
    const plain =
      (kind === "run" ? RUN_NAME : WATCHER_NAME).test(name) &&
      Number.isSafeInteger(count) &&
      count >= 1 &&
      isTime(firstAt) &&
      isTime(lastAt) &&
      firstAt <= lastAt;
    if (!plain) {
      return yield* Effect.logWarning("A health signal was refused: a field is not plain.", {
        kind,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const key = subjectKey(input);
    const all = yield* Ref.get(episodes);
    const previous = Object.hasOwn(all, key) ? all[key] : undefined;
    // A wake that was never confirmed goes out again under the same key, whatever the clock says.
    if (previous?.pending !== undefined) return yield* send(key, previous, botThreadId);
    if (previous !== undefined && now < previous.nextWakeAt) return;
    const step = previous === undefined ? 0 : previous.step + 1;
    const wakes = (previous?.wakes ?? 0) + 1;
    const id = previous?.id ?? (yield* newId);
    const episode: Episode = {
      id,
      kind,
      botThreadId,
      name,
      count,
      firstAt,
      lastAt,
      wakes,
      step,
      nextWakeAt: now + backoff(step),
    };
    const pending = { key: `health:${id}:${wakes}`, text: healthText(episode) };
    // Saved before the send: a wake that is not on disk could be lost by a crash, and one that
    // is gets resent under this key, which the Bot's idempotent command replays.
    if (!(yield* save(sweep({ ...all, [key]: { ...episode, pending } }, now)))) return;
    yield* send(key, { ...episode, pending }, botThreadId);
  }, locked);

  const clear: RepairService["Service"]["clear"] = Effect.fn("RepairService.clear")(
    function* (subject) {
      const key = subjectKey(subject);
      // Most reports are of a healthy thing: no episode, no lock, no write.
      if (!Object.hasOwn(yield* Ref.get(episodes), key)) return;
      yield* locked(
        Effect.gen(function* () {
          const { [key]: _recovered, ...rest } = yield* Ref.get(episodes);
          yield* save(rest);
        }),
      );
    },
  );

  // Untraced: runs for every milestone that wakes a Bot, and nearly all return at the first line.
  const handleMilestone: RepairService["Service"]["handleMilestone"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "thread.run_settled" || event.outcome !== "failed") return;
      if (event.threadId === null || !(yield* bots.isBot(event.threadId))) return;
      const records = yield* threads
        .getThreadRecords(event.threadId, ["runs"], { runIds: [event.runId] })
        .pipe(Effect.option);
      const run =
        records._tag === "Some"
          ? records.value.runs.find((candidate) => candidate.id === event.runId)
          : undefined;
      // A turn a health wake began that fails would signal again, and that wake would start
      // another turn: the loop ends here. A run that cannot be found is left alone for the same reason.
      if (run === undefined || run.userMessageId.startsWith(HEALTH_MESSAGE_PREFIX)) return;
      const occurred = DateTime.make(event.occurredAt);
      const at =
        occurred._tag === "Some"
          ? DateTime.toEpochMillis(occurred.value)
          : yield* Clock.currentTimeMillis;
      yield* signal({
        kind: "run",
        botThreadId: event.threadId,
        name: event.runId,
        count: 1,
        firstAt: at,
        lastAt: at,
      });
    },
  );

  const start: RepairService["Service"]["start"] = Effect.fn("RepairService.start")(function* () {
    yield* Effect.forEach(
      Object.entries(yield* Ref.get(episodes)),
      ([key, episode]) => send(key, episode, episode.botThreadId),
      { discard: true },
    );
  }, locked);

  return RepairService.of({ signal, clear, handleMilestone, start });
});

export const layer = Layer.effect(RepairService, make);
