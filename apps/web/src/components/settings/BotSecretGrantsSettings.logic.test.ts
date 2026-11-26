import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  botGrantTargets,
  parseGrantHosts,
  validateBotSecretGrantDraft,
} from "./BotSecretGrantsSettings.logic";

describe("parseGrantHosts", () => {
  it("splits on commas, spaces and lines, lowercases, and drops repeats", () => {
    expect(parseGrantHosts(" API.example.com, api.example.com\nb.example.org  ")).toEqual([
      "api.example.com",
      "b.example.org",
    ]);
  });

  it("reads blank text as no hosts", () => {
    expect(parseGrantHosts(" , \n ")).toEqual([]);
  });
});

describe("validateBotSecretGrantDraft", () => {
  it("accepts a name and hosts", () => {
    expect(
      validateBotSecretGrantDraft({ name: " GITHUB_TOKEN ", hostsText: "api.github.com" }),
    ).toEqual({ ok: true, name: "GITHUB_TOKEN", hosts: ["api.github.com"] });
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
