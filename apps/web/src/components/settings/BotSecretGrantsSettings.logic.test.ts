import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, SecretProviderId, ThreadId } from "@t3tools/contracts";

import {
  botGrantTargets,
  botSecretGrantSaveCarriesValue,
  botSecretGrantValueIssue,
  replacesBotSecretGrant,
  resolveBotGrantTarget,
  validateBotSecretGrantDraft,
} from "./BotSecretGrantsSettings.logic";

describe("validateBotSecretGrantDraft", () => {
  it("accepts a name and hosts", () => {
    expect(
      validateBotSecretGrantDraft({ name: " GITHUB_TOKEN ", hostsText: "api.github.com" }),
    ).toEqual({ ok: true, name: "GITHUB_TOKEN", hosts: ["api.github.com"] });
  });

  it("lowercases hosts, splits on commas and lines, and drops repeats", () => {
    expect(
      validateBotSecretGrantDraft({
        name: "TOKEN",
        hostsText: " API.example.com, api.example.com\nb.example.org  ",
      }),
    ).toEqual({ ok: true, name: "TOKEN", hosts: ["api.example.com", "b.example.org"] });
  });

  it("rejects a name that is not an upper-case environment variable", () => {
    expect(
      validateBotSecretGrantDraft({ name: "github-token", hostsText: "api.github.com" }),
    ).toEqual({ ok: false, issue: "name" });
    expect(validateBotSecretGrantDraft({ name: "", hostsText: "api.github.com" })).toEqual({
      ok: false,
      issue: "name",
    });
  });

  it("names the first host that is not a plain host name", () => {
    expect(
      validateBotSecretGrantDraft({
        name: "TOKEN",
        hostsText: "api.example.com https://evil.test",
      }),
    ).toEqual({ ok: false, issue: "host", host: "https://evil.test" });
    expect(validateBotSecretGrantDraft({ name: "TOKEN", hostsText: "localhost" })).toEqual({
      ok: false,
      issue: "host",
      host: "localhost",
    });
  });

  it("needs at least one host", () => {
    expect(validateBotSecretGrantDraft({ name: "TOKEN", hostsText: "  " })).toEqual({
      ok: false,
      issue: "hosts_required",
    });
  });

  it("allows eight hosts and rejects nine", () => {
    const hosts = (count: number) =>
      Array.from({ length: count }, (_, index) => `h${index}.example.com`).join(" ");
    expect(validateBotSecretGrantDraft({ name: "TOKEN", hostsText: hosts(8) }).ok).toBe(true);
    expect(validateBotSecretGrantDraft({ name: "TOKEN", hostsText: hosts(9) })).toEqual({
      ok: false,
      issue: "hosts_too_many",
    });
  });
});

describe("botGrantTargets", () => {
  const here = EnvironmentId.make("here");
  const shell = (
    id: string,
    title: string,
    overrides: { environmentId?: EnvironmentId; bot?: boolean; archivedAt?: string | null } = {},
  ) => ({
    environmentId: overrides.environmentId ?? here,
    id: ThreadId.make(id),
    title,
    botConfig: overrides.bot === false ? null : { enabled: true as const, muteChildren: false },
    archivedAt: overrides.archivedAt ?? null,
  });

  it("lists Home first, then this environment's Bots by title", () => {
    const targets = botGrantTargets(
      [
        shell("b", "Zed"),
        shell("home:1", "Home", { bot: false }),
        shell("a", "Ann"),
        shell("c", "Other", { environmentId: EnvironmentId.make("there") }),
        shell("d", "Not a bot", { bot: false }),
        shell("e", "Old", { archivedAt: "2026-11-01T00:00:00.000Z" }),
      ],
      here,
      ThreadId.make("home:1"),
    );
    expect(targets).toEqual([
      { threadId: "home:1", title: "Home", isHome: true },
      { threadId: "a", title: "Ann", isHome: false },
      { threadId: "b", title: "Zed", isHome: false },
    ]);
  });

  it("leaves Home out when it is off", () => {
    expect(botGrantTargets([shell("a", "Ann")], here, null)).toEqual([
      { threadId: "a", title: "Ann", isHome: false },
    ]);
  });
});

describe("replacesBotSecretGrant", () => {
  const existing = [{ name: "GITHUB_TOKEN" }];

  it("is true for a name the Bot already has, ignoring surrounding spaces", () => {
    expect(replacesBotSecretGrant(" GITHUB_TOKEN ", existing)).toBe(true);
  });

  it("is false for a new name", () => {
    expect(replacesBotSecretGrant("SLACK_TOKEN", existing)).toBe(false);
  });
});

describe("botSecretGrantValueIssue", () => {
  it("needs a value", () => {
    expect(botSecretGrantValueIssue("   ", false)).toBe("empty");
  });

  it("needs at least eight characters after trimming", () => {
    expect(botSecretGrantValueIssue("  1234567  ", false)).toBe("too_short");
    expect(botSecretGrantValueIssue("  12345678  ", false)).toBeNull();
  });

  it("takes any reference", () => {
    expect(
      botSecretGrantValueIssue(
        { provider: SecretProviderId.make("op"), reference: "op://a/b/c" },
        true,
      ),
    ).toBeNull();
  });

  it("does not turn a reference grant into a stored one", () => {
    expect(botSecretGrantValueIssue("a long enough value", true)).toBe("reference_required");
  });
});

describe("resolveBotGrantTarget", () => {
  const here = EnvironmentId.make("here");
  const bot = (id: string, environmentId = here) => ({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    botConfig: { enabled: true as const, muteChildren: false },
    archivedAt: null,
  });
  const targets = botGrantTargets(
    [bot("a"), bot("b"), bot("c", EnvironmentId.make("there"))],
    here,
    null,
  );

  it("shows the first Bot when none was asked for", () => {
    expect(resolveBotGrantTarget(targets, null)).toEqual({ kind: "found", target: targets[0] });
  });

  it("finds the Bot that was asked for", () => {
    expect(resolveBotGrantTarget(targets, ThreadId.make("b"))).toEqual({
      kind: "found",
      target: targets[1],
    });
  });

  it("reports a Bot the list does not have instead of showing another", () => {
    expect(resolveBotGrantTarget(targets, ThreadId.make("gone"))).toEqual({ kind: "missing" });
  });

  it("does not find a Bot of another environment", () => {
    expect(resolveBotGrantTarget(targets, ThreadId.make("c"))).toEqual({ kind: "missing" });
  });

  it("has nothing to show without Bots", () => {
    expect(resolveBotGrantTarget([], null)).toEqual({ kind: "none" });
  });
});

describe("botSecretGrantSaveCarriesValue", () => {
  it("keeps the current value when only the hosts are edited, unless a new one is chosen", () => {
    expect(botSecretGrantSaveCarriesValue("hosts", true)).toBe(false);
    expect(botSecretGrantSaveCarriesValue("hosts", false)).toBe(true);
  });

  it("always carries a value when adding a grant or replacing one", () => {
    for (const keep of [true, false]) {
      expect(botSecretGrantSaveCarriesValue("add", keep)).toBe(true);
      expect(botSecretGrantSaveCarriesValue("value", keep)).toBe(true);
    }
  });
});
