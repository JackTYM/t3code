import { createSideQuestionEnvironmentAtoms } from "@t3tools/client-runtime/state/side-questions";

import { connectionAtomRuntime } from "../connection/runtime";

export const sideQuestionEnvironment = createSideQuestionEnvironmentAtoms(connectionAtomRuntime);
