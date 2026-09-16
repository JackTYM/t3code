import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { openDiffFilePrimaryAction, resolveDiffPathForWorkspace } from "./diffFileActions";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openDiffFilePrimaryAction", () => {
  it("routes diff files with a thread through the configured file-open target", () => {
    const openFile = vi.fn();
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openFile,
      openInEditor,
    });

    expect(openFile).toHaveBeenCalledWith({
      workspacePath: "apps/web/src/components/DiffPanel.tsx",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("forwards the click so the modifier escape works from a diff title", () => {
    const openFile = vi.fn();
    const event = { metaKey: true, ctrlKey: false };

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "src/index.ts",
      activeCwd: "/repo/project",
      openFile,
      openInEditor: vi.fn(),
      event,
    });

    expect(openFile).toHaveBeenCalledWith({ workspacePath: "src/index.ts", event });
  });

  it("falls back to the editor without thread context", () => {
    const openFile = vi.fn();
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openFile,
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith(
      "/repo/project/apps/web/src/components/DiffPanel.tsx",
    );
    expect(openFile).not.toHaveBeenCalled();
  });

  it("opens repository-relative diff files from a nested project", () => {
    const openFile = vi.fn();
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openFile,
      openInEditor,
    });

    expect(openFile).toHaveBeenCalledWith({ workspacePath: "Dockerfile" });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("preserves repository-relative paths in a separate worktree", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/Dockerfile",
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: "/repo",
      }),
    ).toBe("frontend/Dockerfile");
  });

  it("handles Windows roots and mixed diff separators", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src\\index.ts",
        workspaceRoot: "C:\\repo\\frontend",
        repositoryRoot: "C:\\repo",
      }),
    ).toBe("src/index.ts");
  });

  it.each([
    { workspaceRoot: "/frontend", repositoryRoot: "/" },
    { workspaceRoot: "C:\\frontend", repositoryRoot: "C:\\" },
  ])("handles filesystem roots: $repositoryRoot", ({ workspaceRoot, repositoryRoot }) => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/index.ts",
        workspaceRoot,
        repositoryRoot,
      }),
    ).toBe("index.ts");
  });

  it.each(["backend/server.ts", "frontend2/app.ts", "frontend/../secret.ts", "C:secret.ts"])(
    "does not open an out-of-project diff path: %s",
    (filePath) => {
      const openFile = vi.fn();
      const openInEditor = vi.fn();

      openDiffFilePrimaryAction({
        threadRef: THREAD_REF,
        filePath,
        activeCwd: "/repo/frontend",
        repositoryRoot: "/repo",
        openFile,
        openInEditor,
      });

      expect(openFile).not.toHaveBeenCalled();
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );
});
