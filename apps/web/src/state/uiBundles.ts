import { useAtomValue } from "@effect/atom-react";
import { createUiBundleEnvironmentAtoms } from "@t3tools/client-runtime/state/ui-bundles";
import { UiBundleError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";
import { primaryServerConfigAtom } from "./server";

export const uiBundleEnvironment = createUiBundleEnvironmentAtoms(connectionAtomRuntime);

const isUiBundleError = Schema.is(UiBundleError);

export function uiBundleFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isUiBundleError(error) ? error.message : formatEnvironmentQueryError(cause);
}

/**
 * The server this page was loaded from: the only one whose bundle a reload of this window
 * switches, so it is the only one the UI offers updates for.
 */
export function usePrimaryUiBundle() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const capabilities = useAtomValue(primaryServerConfigAtom, (config) =>
    config === null ? null : config.environment.capabilities,
  );
  const query = useEnvironmentQuery(
    environmentId !== null && capabilities?.uiBundles === true
      ? uiBundleEnvironment.state({ environmentId, input: {} })
      : null,
  );
  return { environmentId, capabilities, state: query.data };
}
