import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { BotSecretGrantName, BotSecretGrantSetInput } from "./botSecretGrants.ts";

const decodeSet = Schema.decodeUnknownEffect(BotSecretGrantSetInput);
const encodeSet = Schema.encodeEffect(BotSecretGrantSetInput);
const isName = Schema.is(BotSecretGrantName);

const set = (overrides: Record<string, unknown> = {}) => ({
  threadId: "thread:bot",
  name: "GITHUB_TOKEN",
  hosts: ["api.github.com"],
  value: { type: "stored", secret: "ghp_planted" },
  ...overrides,
});

const manyHosts = (count: number) => Array.from({ length: count }, (_, i) => `h${i}.a.com`);

it.each(["GITHUB_TOKEN", "A", "A1_B2"])("accepts the grant name %s", (name) => {
  assert.isTrue(isName(name));
});

it.each(["", "github_token", "1TOKEN", "_TOKEN", "TO-KEN", "A".repeat(65)])(
  "refuses the grant name %j",
  (name) => {
    assert.isFalse(isName(name));
  },
);

it.effect.each([
  "localhost",
  "github",
  "API.github.com",
  "-a.com",
  "a..com",
  "a.com/path",
  "a.com:443",
  "*.a.com",
])("refuses the host %j", (host) =>
  decodeSet(set({ hosts: [host] })).pipe(Effect.flip, Effect.asVoid),
);

it.effect("needs between one and eight hosts", () =>
  Effect.gen(function* () {
    yield* decodeSet(set({ hosts: ["a.com"] }));
    yield* decodeSet(set({ hosts: manyHosts(8) }));
    yield* decodeSet(set({ hosts: [] })).pipe(Effect.flip);
    yield* decodeSet(set({ hosts: manyHosts(9) })).pipe(Effect.flip);
  }),
);

it.effect("reads a stored value from the wire as redacted, and writes it back plainly", () =>
  Effect.gen(function* () {
    const input = yield* decodeSet(set());
    assert.strictEqual(input.value.type, "stored");
    if (input.value.type !== "stored") return;
    assert.isTrue(Redacted.isRedacted(input.value.secret));
    assert.notInclude(JSON.stringify(input), "ghp_planted");
    assert.strictEqual(Redacted.value(input.value.secret), "ghp_planted");
    const wire = yield* encodeSet(input);
    assert.deepStrictEqual(wire.value, { type: "stored", secret: "ghp_planted" });
  }),
);

it.effect("takes a reference to a secret provider in place of a value", () =>
  Effect.gen(function* () {
    const input = yield* decodeSet(
      set({ value: { type: "reference", reference: { provider: "op", reference: "op://v/i/f" } } }),
    );
    assert.strictEqual(input.value.type, "reference");
  }),
);
