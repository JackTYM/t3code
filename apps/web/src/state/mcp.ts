import { createMcpEnvironmentAtoms } from "@t3tools/client-runtime/state/mcp";

import { connectionAtomRuntime } from "../connection/runtime";

export const mcpEnvironment = createMcpEnvironmentAtoms(connectionAtomRuntime);
