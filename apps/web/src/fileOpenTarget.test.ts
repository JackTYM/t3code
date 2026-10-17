import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canUseFileShellActions, resolveFileOpenTarget } from "./fileOpenTarget";

const MAC = "MacIntel";
const plain = { metaKey: false, ctrlKey: false };
const modified = { metaKey: true, ctrlKey: false };
const capable = { canOpenInEditor: true, canRevealInFileManager: true, platform: MAC };

describe("resolveFileOpenTarget", () => {
  it("opens the panel by default, which is what every file link did before the setting", () => {
    expect(resolveFileOpenTarget({ event: plain, preference: "panel", ...capable })).toBe("panel");
  });

  it("honours a preference the server can serve", () => {
    expect(resolveFileOpenTarget({ event: plain, preference: "editor", ...capable })).toBe(
      "editor",
    );
    expect(resolveFileOpenTarget({ event: plain, preference: "file-manager", ...capable })).toBe(
      "file-manager",
    );
  });

  it("falls back to the panel when the server cannot honour the preference", () => {
    // A remote connection or mobile: shell.openInEditor would act on a machine
    // the user is not sitting at, so the click still has to land somewhere.
    expect(
      resolveFileOpenTarget({
        event: plain,
        preference: "editor",
        canOpenInEditor: false,
        canRevealInFileManager: false,
        platform: MAC,
      }),
    ).toBe("panel");
    expect(
      resolveFileOpenTarget({
        event: plain,
        preference: "file-manager",
        canOpenInEditor: true,
        canRevealInFileManager: false,
        platform: MAC,
      }),
    ).toBe("panel");
  });

  it("keeps Cmd-click on the panel default opening the editor, as it did before", () => {
    expect(resolveFileOpenTarget({ event: modified, preference: "panel", ...capable })).toBe(
      "editor",
    );
  });

  it("makes the modifier the way back to the panel when the default is external", () => {
    expect(resolveFileOpenTarget({ event: modified, preference: "editor", ...capable })).toBe(
      "panel",
    );
    expect(resolveFileOpenTarget({ event: modified, preference: "file-manager", ...capable })).toBe(
      "panel",
    );
  });

  it("degrades the modifier escape too rather than routing to a missing editor", () => {
    expect(
      resolveFileOpenTarget({
        event: modified,
        preference: "panel",
        canOpenInEditor: false,
        canRevealInFileManager: true,
        platform: MAC,
      }),
    ).toBe("panel");
  });

  it("reads the modifier per platform, matching the shipped file-link rule", () => {
    expect(
      resolveFileOpenTarget({
        event: { metaKey: false, ctrlKey: true },
        preference: "panel",
        canOpenInEditor: true,
        canRevealInFileManager: true,
        platform: "Linux x86_64",
      }),
    ).toBe("editor");
    // Cmd is not the modifier off macOS, so this is an ordinary click.
    expect(
      resolveFileOpenTarget({
        event: modified,
        preference: "panel",
        canOpenInEditor: true,
        canRevealInFileManager: true,
        platform: "Linux x86_64",
      }),
    ).toBe("panel");
  });
});

describe("canUseFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions for local environments", () => {
    expect(canUseFileShellActions(environmentId, "local-exec", true)).toBe(true);
  });

  it("hides shell actions until the environment mode is resolved", () => {
    expect(canUseFileShellActions(environmentId, "local-exec", false)).toBe(false);
  });

  it("hides editor and file manager actions for remote environments", () => {
    expect(canUseFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
  });

  it("hides shell actions when no environment owns the file", () => {
    expect(canUseFileShellActions(null, "local-exec", true)).toBe(false);
  });
});
