import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type * as PayloadSigner from "../auth/PayloadSigner.ts";

// `data` stays the exact text that was signed, so the signature is checked over what was read.
const SignedFile = Schema.fromJsonString(
  Schema.Struct({ data: Schema.String, signature: Schema.String }),
);
const decodeSignedFile = Schema.decodeEffect(SignedFile);
const encodeSignedFile = Schema.encodeEffect(SignedFile);

export type SignedRead =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unsigned" }
  | { readonly _tag: "BadSignature" }
  | { readonly _tag: "Verified"; readonly data: string };

/** A state file of `{ data, signature }` that only a holder of the signer's key could have written. */
export const make = <E>(options: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly signer: PayloadSigner.PayloadSigner<E>;
  readonly stateDir: string;
  readonly statePath: string;
}) => {
  const { fileSystem, signer, stateDir, statePath } = options;
  return {
    /**
     * What is on disk. A read, the secret store or the key that fail may pass, and are left to the
     * caller; a file that is not a signed one will not become one by waiting, and is `Unsigned`.
     */
    read: Effect.gen(function* () {
      const text = yield* fileSystem.readFileString(statePath).pipe(
        Effect.catchIf(
          (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
          () => Effect.undefined,
        ),
      );
      if (text === undefined) return { _tag: "Missing" } as const satisfies SignedRead;
      const signed = yield* decodeSignedFile(text).pipe(
        Effect.catchIf(Schema.isSchemaError, () => Effect.undefined),
      );
      if (signed === undefined) return { _tag: "Unsigned" } as const satisfies SignedRead;
      if (!(yield* signer.verify(signed.data, signed.signature))) {
        return { _tag: "BadSignature" } as const satisfies SignedRead;
      }
      return { _tag: "Verified", data: signed.data } as const satisfies SignedRead;
    }),
    write: Effect.fnUntraced(function* (data: string) {
      const text = yield* encodeSignedFile({ data, signature: yield* signer.sign(data) });
      // Renamed into place, so a crash cannot leave a half-written file that reads as no state.
      const temporary = `${statePath}.tmp`;
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 });
      yield* fileSystem.rename(temporary, statePath);
    }),
  };
};
