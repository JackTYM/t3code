import type { BotMailBackfillStatus, BotMailStatus, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botMailCountRows,
  botMailDeliveryOutcome,
  botMailHookControls,
  botMailHookProblem,
  botMailImportControl,
  botMailImportDays,
  botMailImportKind,
  botMailImportTarget,
  botMailSaveControl,
  botMailSettingsPlan,
  botMailUnknownAccounts,
  EMPTY_BOT_MAIL_SETTINGS_DRAFT,
  parseBotMailMailbox,
  parseBotMailWholeNumber,
} from "./BotMailView.logic";

const MAC = "env-mac" as EnvironmentId;
const OTHER = "env-other" as EnvironmentId;
const operate = { operate: true };

const server = {
  mailboxes: ["me@gmail.com"],
  retentionDays: 90,
  digestWindowMinutes: 5,
};

const backfill = (overrides: Partial<BotMailBackfillStatus> = {}): BotMailBackfillStatus => ({
  state: "done",
  environmentId: MAC,
  sinceDays: 30,
  stored: 4,
  startedAt: "2026-11-25T10:00:00.000Z" as BotMailBackfillStatus["startedAt"],
  updatedAt: "2026-11-25T10:01:00.000Z" as BotMailBackfillStatus["updatedAt"],
  ...overrides,
});

describe("parseBotMailMailbox", () => {
  it("trims and lower-cases to the form the server stores", () => {
    expect(parseBotMailMailbox("  Me@ICloud.com ", [])).toEqual({
      ok: true,
      address: "me@icloud.com",
    });
  });

  it("refuses what the server would refuse", () => {
    expect(parseBotMailMailbox("   ", [])).toEqual({ ok: false, problem: "empty" });
    expect(parseBotMailMailbox("not-an-address", [])).toEqual({ ok: false, problem: "invalid" });
    expect(parseBotMailMailbox("a b@example.com", [])).toEqual({ ok: false, problem: "invalid" });
    expect(parseBotMailMailbox("<me@example.com>", [])).toEqual({ ok: false, problem: "invalid" });
    expect(parseBotMailMailbox(`${"a".repeat(320)}@example.com`, [])).toEqual({
      ok: false,
      problem: "too_long",
    });
  });

  it("refuses a repeat regardless of case, and a list that is full", () => {
    expect(parseBotMailMailbox("ME@gmail.com", ["me@gmail.com"])).toEqual({
      ok: false,
      problem: "duplicate",
    });
    const full = Array.from({ length: 50 }, (_, index) => `a${index}@example.com`);
    expect(parseBotMailMailbox("b@example.com", full)).toEqual({ ok: false, problem: "too_many" });
  });

  it("accepts a placeholder address typed by hand, since the server does", () => {
    expect(parseBotMailMailbox("abcd1234@mail-app.invalid", [])).toEqual({
      ok: true,
      address: "abcd1234@mail-app.invalid",
    });
  });
});

describe("parseBotMailWholeNumber", () => {
  it("accepts 1 to the maximum and nothing else", () => {
    expect(parseBotMailWholeNumber("1", 90)).toBe(1);
    expect(parseBotMailWholeNumber(" 90 ", 90)).toBe(90);
    expect(parseBotMailWholeNumber("0", 90)).toBeNull();
    expect(parseBotMailWholeNumber("91", 90)).toBeNull();
    expect(parseBotMailWholeNumber("", 90)).toBeNull();
    expect(parseBotMailWholeNumber("1.5", 90)).toBeNull();
    expect(parseBotMailWholeNumber("-3", 90)).toBeNull();
    expect(parseBotMailWholeNumber("1e2", 90)).toBeNull();
  });
});

describe("botMailSettingsPlan", () => {
  it("follows the server until the user changes something", () => {
    const plan = botMailSettingsPlan(server, EMPTY_BOT_MAIL_SETTINGS_DRAFT);
    expect(plan).toMatchObject({
      mailboxes: ["me@gmail.com"],
      retentionText: "90",
      digestText: "5",
      changed: false,
      save: undefined,
    });
  });

  it("saves the whole draft once it is valid", () => {
    const plan = botMailSettingsPlan(server, {
      mailboxes: ["me@gmail.com", "me@icloud.com"],
      retention: "30",
      digest: "15",
    });
    expect(plan.save).toEqual({
      mailboxes: ["me@gmail.com", "me@icloud.com"],
      retentionDays: 30,
      digestWindowMinutes: 15,
    });
  });

  it("is changed but not saveable while a number is out of range", () => {
    const plan = botMailSettingsPlan(server, {
      ...EMPTY_BOT_MAIL_SETTINGS_DRAFT,
      retention: "4000",
    });
    expect(plan).toMatchObject({ changed: true, retentionValid: false, save: undefined });
    const digest = botMailSettingsPlan(server, {
      ...EMPTY_BOT_MAIL_SETTINGS_DRAFT,
      digest: "1441",
    });
    expect(digest).toMatchObject({ digestValid: false, save: undefined });
    expect(
      botMailSettingsPlan(server, {
        ...EMPTY_BOT_MAIL_SETTINGS_DRAFT,
        retention: "3650",
        digest: "1440",
      }).save,
    ).toBeDefined();
  });

  it("does not count the same list in another order, or the same number, as a change", () => {
    const two = { ...server, mailboxes: ["a@x.com", "b@x.com"] };
    expect(
      botMailSettingsPlan(two, { mailboxes: ["b@x.com", "a@x.com"], retention: "90", digest: "5" })
        .changed,
    ).toBe(false);
  });

  it("can save an emptied list, which keeps no mail", () => {
    const plan = botMailSettingsPlan(server, { ...EMPTY_BOT_MAIL_SETTINGS_DRAFT, mailboxes: [] });
    expect(plan.save).toMatchObject({ mailboxes: [] });
  });
});

describe("botMailCountRows", () => {
  it("lists every allowed mailbox, even with no mail, split by origin", () => {
    const rows = botMailCountRows({
      mailboxes: ["b@x.com", "a@x.com"],
      counts: [
        { mailbox: "a@x.com", origin: "forward", count: 3 },
        { mailbox: "a@x.com", origin: "backfill", count: 10 },
      ],
    });
    expect(rows).toEqual([
      { mailbox: "a@x.com", forward: 3, backfill: 10, listed: true },
      { mailbox: "b@x.com", forward: 0, backfill: 0, listed: true },
    ]);
  });

  it("keeps an address that has mail but left the list, after the listed ones", () => {
    const rows = botMailCountRows({
      mailboxes: ["z@x.com"],
      counts: [{ mailbox: "a@x.com", origin: "forward", count: 2 }],
    });
    expect(rows.map((row) => [row.mailbox, row.listed])).toEqual([
      ["z@x.com", true],
      ["a@x.com", false],
    ]);
  });
});

describe("botMailUnknownAccounts", () => {
  const unknown = (mailbox: string, seen: number) => ({ mailbox, seen, label: "" });

  it("offers each placeholder the import dropped until it is allowed", () => {
    const status = {
      mailboxes: ["me@gmail.com"],
      unknownAccounts: [
        unknown("abcd1234@mail-app.invalid", 12),
        unknown("ffff0000@mail-app.invalid", 1),
      ],
    };
    expect(botMailUnknownAccounts(status)).toEqual([
      { mailbox: "abcd1234@mail-app.invalid", seen: 12 },
      { mailbox: "ffff0000@mail-app.invalid", seen: 1 },
    ]);
    expect(
      botMailUnknownAccounts({ ...status, mailboxes: ["abcd1234@mail-app.invalid"] }).map(
        (entry) => entry.mailbox,
      ),
    ).toEqual(["ffff0000@mail-app.invalid"]);
  });

  it("never offers an address that is not a placeholder", () => {
    expect(
      botMailUnknownAccounts({ mailboxes: [], unknownAccounts: [unknown("me@gmail.com", 3)] }),
    ).toEqual([]);
    expect(botMailUnknownAccounts({ mailboxes: [] })).toEqual([]);
  });
});

describe("botMailHookControls", () => {
  const hook = { taskId: "task-1", enabled: true, signed: true } as NonNullable<
    BotMailStatus["hook"]
  >;

  it("creates only when there is no hook and rotates only when there is one", () => {
    expect(botMailHookControls(undefined, operate)).toEqual({
      create: { enabled: true },
      rotate: { enabled: false, reason: "no_hook" },
    });
    expect(botMailHookControls(hook, operate)).toEqual({
      create: { enabled: false, reason: "hook_exists" },
      rotate: { enabled: true },
    });
  });

  it("needs operate access for both, whatever the hook", () => {
    const none = { operate: false };
    expect(botMailHookControls(undefined, none).create).toEqual({
      enabled: false,
      reason: "needs_operate_access",
    });
    expect(botMailHookControls(hook, none).rotate).toEqual({
      enabled: false,
      reason: "needs_operate_access",
    });
  });
});

describe("botMailHookProblem", () => {
  const hook = (overrides: Partial<NonNullable<BotMailStatus["hook"]>>) =>
    ({ taskId: "task-1", enabled: true, signed: true, ...overrides }) as NonNullable<
      BotMailStatus["hook"]
    >;

  it("names the most serious problem first", () => {
    expect(botMailHookProblem(hook({}))).toBeNull();
    expect(botMailHookProblem(hook({ enabled: false, signed: false }))).toBe("disabled");
    expect(botMailHookProblem(hook({ signed: false }))).toBe("unsigned");
    expect(botMailHookProblem(hook({ lastOutcome: "rejected_signature" }))).toBe(
      "signature_rejected",
    );
    expect(botMailHookProblem(hook({ lastOutcome: "accepted" }))).toBeNull();
  });
});

describe("botMailDeliveryOutcome", () => {
  it("separates good, bad and unknown outcomes", () => {
    expect(botMailDeliveryOutcome("accepted").tone).toBe("good");
    expect(botMailDeliveryOutcome("rejected_signature")).toMatchObject({
      kind: "rejected_signature",
      tone: "bad",
    });
    expect(botMailDeliveryOutcome("duplicate")).toEqual({
      kind: "other",
      raw: "duplicate",
      tone: "neutral",
    });
    expect(botMailDeliveryOutcome("some_new_outcome").raw).toBe("some new outcome");
  });
});

describe("history import", () => {
  const linked = new Map<EnvironmentId, string>([
    [MAC, "Jack's Mac"],
    [OTHER, "Desktop"],
  ]);

  it("picks the machine asked for, else the last used, else the first", () => {
    expect(botMailImportTarget(linked, OTHER, MAC)).toBe(OTHER);
    expect(botMailImportTarget(linked, null, OTHER)).toBe(OTHER);
    expect(botMailImportTarget(linked, null, undefined)).toBe(MAC);
    // A machine that is no longer linked cannot be a target.
    expect(botMailImportTarget(linked, "gone" as EnvironmentId, "gone" as EnvironmentId)).toBe(MAC);
    expect(botMailImportTarget(new Map(), null, MAC)).toBeNull();
  });

  it("starts from a window the picker offers", () => {
    expect(botMailImportDays(null, undefined)).toBe(30);
    expect(botMailImportDays(null, 60)).toBe(60);
    expect(botMailImportDays(null, 45)).toBe(30);
    expect(botMailImportDays(90, 60)).toBe(90);
  });

  it("resumes only the same unfinished pull", () => {
    expect(botMailImportKind(undefined, MAC, 30)).toBe("import");
    expect(botMailImportKind(backfill({ state: "waiting" }), MAC, 30)).toBe("resume");
    expect(botMailImportKind(backfill({ state: "failed" }), MAC, 30)).toBe("resume");
    expect(botMailImportKind(backfill({ state: "waiting" }), MAC, 60)).toBe("import");
    expect(botMailImportKind(backfill({ state: "waiting" }), OTHER, 30)).toBe("import");
    expect(botMailImportKind(backfill({ state: "done" }), MAC, 30)).toBe("again");
  });

  it("explains why a pull cannot start", () => {
    const base = { backfill: undefined, environmentId: MAC, grants: operate };
    expect(botMailImportControl(base)).toEqual({ enabled: true });
    expect(botMailImportControl({ ...base, grants: { operate: false } })).toEqual({
      enabled: false,
      reason: "needs_operate_access",
    });
    expect(botMailImportControl({ ...base, environmentId: null })).toEqual({
      enabled: false,
      reason: "no_linked_environment",
    });
    expect(botMailImportControl({ ...base, backfill: backfill({ state: "running" }) })).toEqual({
      enabled: false,
      reason: "import_running",
    });
    // Waiting and failed pulls can be tried again.
    expect(
      botMailImportControl({ ...base, backfill: backfill({ state: "waiting" }) }).enabled,
    ).toBe(true);
  });
});

describe("botMailSaveControl", () => {
  it("needs a change that is valid and operate access", () => {
    const unchanged = botMailSettingsPlan(server, EMPTY_BOT_MAIL_SETTINGS_DRAFT);
    const changed = botMailSettingsPlan(server, {
      ...EMPTY_BOT_MAIL_SETTINGS_DRAFT,
      retention: "30",
    });
    expect(botMailSaveControl(unchanged, operate)).toEqual({
      enabled: false,
      reason: "nothing_to_save",
    });
    expect(botMailSaveControl(changed, operate)).toEqual({ enabled: true });
    expect(botMailSaveControl(changed, { operate: false })).toEqual({
      enabled: false,
      reason: "needs_operate_access",
    });
  });
});
