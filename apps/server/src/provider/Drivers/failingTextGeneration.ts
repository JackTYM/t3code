import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";

/**
 * For drivers that cannot run one-shot generations. They also advertise
 * `supportsTextGeneration: false`, so callers should not pick them; this keeps
 * a stale selection from hanging or crashing.
 */
export const makeFailingTextGeneration = (detail: string): TextGeneration["Service"] => {
  const fail = (operation: string) => Effect.fail(new TextGenerationError({ operation, detail }));
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
};
