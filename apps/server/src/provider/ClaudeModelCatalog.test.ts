import { assert, describe, it } from "@effect/vitest";
import { type ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { resolveProviderCatalog, type ModelManifestData } from "./ModelManifest.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  capClaudeCatalogEffort,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  listUngatedClaudeModels,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  resolveClaudeUpdateRequiredModels,
  scopeClaudeModelCatalog,
  withClaudeCodeModelRoutes,
} from "./ClaudeModelCatalog.ts";

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [
                  { id: "large", label: "Large", isDefault: true },
                  { id: "small", label: "Small" },
                ],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

const CLAUDE = ProviderDriverKind.make("claudeAgent");

const catalogFromManifest = (data: ModelManifestData) =>
  resolveClaudeModelCatalog(resolveProviderCatalog(data, CLAUDE) ?? undefined);

describe("Claude model catalog", () => {
  it("resolves capacity from selected options and fixed catalog windows without guessing custom models", () => {
    const source = manifest();
    const profile = source.providers!.claudeAgent!.profiles.synthetic!;
    const catalog = catalogFromManifest({
      ...source,
      providers: {
        claudeAgent: {
          ...source.providers!.claudeAgent!,
          profiles: {
            fixed: {
              capabilities: { optionDescriptors: [] },
              adapter: { claudeCode: { fixedContextWindowTokens: 64_000 } },
            },
            synthetic: {
              ...profile,
              adapter: { claudeCode: { contextWindowTokens: { large: 1_000_000, small: 32_000 } } },
            },
          },
          models: [
            ...source.providers!.claudeAgent!.models,
            {
              slug: "fixed",
              name: "Fixed",
              status: "current",
              profile: "fixed",
            },
          ],
        },
      },
    });
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" };
    assert.equal(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        ...selection,
        options: [{ id: "contextWindow", value: "small" }],
      }),
      32_000,
    );
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "fixed" }),
      64_000,
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "custom" }),
    );
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = catalogFromManifest(manifest());
    // `opusplan` is code-defined and old enough to be offered at every version here.
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.1.9").map((model) => model.slug),
      ["opusplan"],
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "opusplan"],
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.1.9"), [
      { slug: "claude-synthetic-next", name: "Claude Synthetic Next", minVersion: "3.2.0" },
    ]);
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.2.0"), []);
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = catalogFromManifest(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
      "synthetic",
      {
        slug: "claude-custom-tuned",
        name: "Tuned",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "gentle", label: "Gentle", isDefault: true },
                { id: "brutal", label: "Brutal" },
                { id: "ultracode", label: "Ultracode" },
              ],
            },
          ],
        },
      },
    ]);

    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.isUndefined(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"));
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "max"), "max");
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "max", "synthetic"), "max");

    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
    );
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(catalog, "claude-custom-tuned").optionDescriptors?.map(
        ({ id, type }) => `${id}:${type}`,
      ),
      ["effort:select", "ultracode:boolean"],
    );
    assert.strictEqual(
      normalizeClaudeCatalogEffort(catalog, "brutal", "claude-custom-tuned"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-custom-tuned",
        options: [{ id: "effort", value: "brutal" }],
      }),
      "claude-custom-tuned",
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "opusplan", "claude-custom-tuned"],
    );
  });

  // Rows Claude Code 2.1.310 reports from initialization for each configuration.
  it("sends the model id Claude Code reports when it serves a catalog model under another id", () => {
    const apiModel = (
      catalog: ClaudeModelCatalog,
      model: string,
      options?: ModelSelection["options"],
    ) =>
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model,
        ...(options ? { options } : {}),
      });

    // Bedrock with ANTHROPIC_DEFAULT_*_MODEL and an availableModels allowlist of their ids.
    const configuredBedrock = withClaudeCodeModelRoutes(BUNDLED_CLAUDE_MODEL_CATALOG, [
      { value: "default", resolvedModel: "global.anthropic.claude-opus-5-5" },
      { value: "sonnet", resolvedModel: "global.anthropic.claude-sonnet-5-5[1m]" },
      { value: "opus", resolvedModel: "global.anthropic.claude-opus-5-5" },
      { value: "haiku", resolvedModel: "global.anthropic.claude-haiku-5-5" },
    ]);
    assert.strictEqual(apiModel(configuredBedrock, "claude-haiku-5-5"), "haiku");
    assert.strictEqual(apiModel(configuredBedrock, "haiku-5.5"), "haiku");
    assert.strictEqual(apiModel(configuredBedrock, "claude-sonnet-5-5"), "sonnet");
    assert.strictEqual(apiModel(configuredBedrock, "claude-opus-5-5"), "opus");
    assert.strictEqual(apiModel(configuredBedrock, "claude-opus-5"), "claude-opus-5");

    // Bedrock with no model settings: Claude Code's `haiku` is Haiku 4.5 there.
    const defaultBedrock = withClaudeCodeModelRoutes(BUNDLED_CLAUDE_MODEL_CATALOG, [
      {
        value: "us.anthropic.claude-opus-4-6-v1",
        resolvedModel: "us.anthropic.claude-opus-4-6-v1",
      },
      {
        value: "us.anthropic.claude-opus-4-6-v1[1m]",
        resolvedModel: "us.anthropic.claude-opus-4-6-v1[1m]",
      },
      { value: "haiku", resolvedModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
    ]);
    assert.strictEqual(
      apiModel(defaultBedrock, "claude-opus-4-6", [{ id: "contextWindow", value: "1m" }]),
      "us.anthropic.claude-opus-4-6-v1[1m]",
    );
    assert.strictEqual(
      apiModel(defaultBedrock, "claude-opus-4-6", [{ id: "contextWindow", value: "200k" }]),
      "us.anthropic.claude-opus-4-6-v1",
    );
    assert.strictEqual(apiModel(defaultBedrock, "claude-haiku-4-5"), "haiku");
    assert.strictEqual(apiModel(defaultBedrock, "claude-haiku-5-5"), "claude-haiku-5-5");

    // First-party ids already are what Claude Code runs, even when an alias points elsewhere.
    const firstParty = withClaudeCodeModelRoutes(BUNDLED_CLAUDE_MODEL_CATALOG, [
      { value: "default", resolvedModel: "claude-opus-5-5" },
      { value: "opus", resolvedModel: "claude-opus-5-5" },
      { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1[1m]" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    ]);
    assert.strictEqual(firstParty, BUNDLED_CLAUDE_MODEL_CATALOG);
  });

  it("marks effort options that would run above the cap without changing ids or defaults", () => {
    const effortModel = (slug: string) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
              { id: "max", label: "Max" },
              { id: "ultracode", label: "Ultracode" },
              { id: "ultrathink", label: "Ultrathink" },
            ],
          },
        ],
      },
    });
    const models = [effortModel("claude-plain"), effortModel("claude-remapped")];
    const catalog: ClaudeModelCatalog = {
      models: [
        {
          model: models[0]!,
          runtime: { effortMap: { ultracode: "xhigh", ultrathink: null } },
          compatibility: {},
        },
        {
          model: models[1]!,
          runtime: { effortMap: { max: "high", xhigh: "max", ultrathink: null } },
          compatibility: {},
        },
      ],
    };
    const options = (cap: "high" | "xhigh") =>
      capClaudeCatalogEffort(catalog, models, [{ maxEffortLevel: cap }]).map((model) => {
        const effort = model.capabilities?.optionDescriptors?.[0];
        return effort?.type === "select" ? effort.options : undefined;
      });

    assert.deepStrictEqual(options("high"), [
      [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra High (capped to High)" },
        { id: "max", label: "Max (capped to High)" },
        { id: "ultracode", label: "Ultracode (capped to High)" },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra High (capped to High)" },
        { id: "max", label: "Max" },
        { id: "ultracode", label: "Ultracode" },
        { id: "ultrathink", label: "Ultrathink" },
      ],
    ]);
    // An effortMap that sends Extra High as max stays unmarked under an xhigh cap: the CLI runs
    // it at xhigh, which is what the label says.
    assert.deepStrictEqual(
      options("xhigh").map((model) => model?.map((option) => option.label)),
      [
        ["Medium", "High", "Extra High", "Max (capped to Extra High)", "Ultracode", "Ultrathink"],
        ["Medium", "High", "Extra High", "Max", "Ultracode", "Ultrathink"],
      ],
    );

    // A per-model cap applies without a top-level one and leaves other models uncapped.
    assert.deepStrictEqual(
      capClaudeCatalogEffort(catalog, models, [
        { modelMaxEffortLevels: new Map([["claude-plain", "high"]]) },
      ]).map((model) => {
        const effort = model.capabilities?.optionDescriptors?.[0];
        return effort?.type === "select" ? effort.options.map((option) => option.label) : [];
      }),
      [
        [
          "Medium",
          "High",
          "Extra High (capped to High)",
          "Max (capped to High)",
          "Ultracode (capped to High)",
          "Ultrathink",
        ],
        ["Medium", "High", "Extra High", "Max", "Ultracode", "Ultrathink"],
      ],
    );

    // Without an Extra High option (Opus 4.6), the CLI clamps an xhigh cap down to High.
    const noXhigh = {
      slug: "claude-no-xhigh",
      name: "claude-no-xhigh",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
      },
    };
    const [capped] = capClaudeCatalogEffort(
      { models: [] },
      [noXhigh],
      [{ maxEffortLevel: "xhigh" }],
    );
    const cappedEffort = capped?.capabilities?.optionDescriptors?.[0];
    assert.deepStrictEqual(
      cappedEffort?.type === "select" ? cappedEffort.options.map((option) => option.label) : [],
      ["Low", "Medium", "High", "Max (capped to High)"],
    );
  });

  it("leaves custom model effort labels alone under a cap", () => {
    const custom = {
      slug: "claude-custom-copy",
      name: "Copy",
      isCustom: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max (capped to High)" },
            ],
          },
        ],
      },
    };

    assert.deepStrictEqual(
      capClaudeCatalogEffort({ models: [] }, [custom], [{ maxEffortLevel: "high" }]),
      [custom],
    );
  });

  it("resolves maxEffortLevel per settings source and per model key like Claude Code", () => {
    const opus = {
      slug: "claude-opus-5-5",
      name: "Opus 5.5",
      isCustom: false,
      aliases: ["opus", "opus-5.5", "claude-opus-5.5"],
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
      },
    };
    const catalog: ClaudeModelCatalog = {
      models: [
        { model: opus, runtime: {}, compatibility: {} },
        {
          model: {
            slug: "claude-opus-5",
            name: "Opus 5",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
          runtime: {},
          compatibility: {},
        },
      ],
    };
    const maxLabel = (sources: Parameters<typeof capClaudeCatalogEffort>[2]) => {
      const effort = capClaudeCatalogEffort(catalog, [opus], sources)[0]?.capabilities
        ?.optionDescriptors?.[0];
      return effort?.type === "select" ? effort.options.at(-1)?.label : undefined;
    };
    const perModel = (entries: Record<string, "low" | "medium" | "high" | "max">) => ({
      modelMaxEffortLevels: new Map(Object.entries(entries)),
    });

    // Claude Code matches family aliases and [1m] spellings case-insensitively.
    assert.strictEqual(maxLabel([perModel({ Opus: "medium" })]), "Max (capped to Medium)");
    assert.strictEqual(
      maxLabel([perModel({ "claude-opus-5-5[1M]": "medium" })]),
      "Max (capped to Medium)",
    );
    assert.strictEqual(maxLabel([perModel({ " OPUS[1m] ": "medium" })]), "Max (capped to Medium)");
    // Other keys name the most specific model id they contain, so dated and provider-prefixed ids
    // match while the catalog's dotted aliases and a less specific model id do not.
    for (const key of [
      "claude-opus-5-5-20260101",
      "CLAUDE-OPUS-5-5-20260101[1m]",
      "us.anthropic.claude-opus-5-5-v1:0",
      "claude-opus-5-5-latest",
    ]) {
      assert.strictEqual(maxLabel([perModel({ [key]: "medium" })]), "Max (capped to Medium)", key);
    }
    for (const key of ["claude-opus-5.5", "opus-5.5", "opus-5-5", "opus [1m]", "claude-opus-5"]) {
      assert.strictEqual(maxLabel([perModel({ [key]: "medium" })]), "Max", key);
    }
    // Keys naming the same model keep the lowest cap, and a `max` key does not exempt it.
    assert.strictEqual(
      maxLabel([perModel({ opus: "max", "claude-opus-5-5": "low" })]),
      "Max (capped to Low)",
    );
    // A per-model `max` only exempts the model from its own source's top-level cap.
    assert.strictEqual(
      maxLabel([{ maxEffortLevel: "medium", ...perModel({ opus: "max" }) }]),
      "Max",
    );
    assert.strictEqual(
      maxLabel([perModel({ opus: "max" }), { maxEffortLevel: "high" }]),
      "Max (capped to High)",
    );
    assert.strictEqual(
      maxLabel([{ maxEffortLevel: "medium" }, perModel({ opus: "high" })]),
      "Max (capped to Medium)",
    );
  });
});

describe("account-gated Claude models", () => {
  const MYTHOS = "claude-mythos-5-1";
  const listed = (accountModelIds?: ReadonlySet<string>) =>
    resolveClaudeModelsForVersion(catalogFromManifest(manifest()), "3.2.0", accountModelIds).map(
      (model) => model.slug,
    );

  it("offers Mythos only to an account that reports it", () => {
    assert.isFalse(listed().includes(MYTHOS));
    assert.isFalse(listed(new Set(["claude-fable-5-1"])).includes(MYTHOS));
    assert.isTrue(listed(new Set([MYTHOS])).includes(MYTHOS));
  });

  it("leaves every other model unaffected by the account's list", () => {
    assert.deepStrictEqual(
      listed(new Set([MYTHOS])).filter((slug) => slug !== MYTHOS),
      listed(),
    );
  });

  it("keeps a gated model resolvable while it is unlisted", () => {
    const catalog = catalogFromManifest(manifest());
    assert.strictEqual(resolveClaudeModelSlug(catalog, "mythos"), MYTHOS);
    assert.isDefined(
      getClaudeCatalogModelCapabilities(catalog, MYTHOS).optionDescriptors?.find(
        (descriptor) => descriptor.id === "effort",
      ),
    );
  });

  it("keeps a gated model out of ungated lists and upgrade prompts", () => {
    const catalog = catalogFromManifest(manifest());
    assert.isFalse(listUngatedClaudeModels(catalog).some((model) => model.slug === MYTHOS));
    // A CLI older than every model: only ungated ones may be named.
    assert.notInclude(formatClaudeVersionUpgradeMessage(catalog, "1.0.0") ?? "", "Mythos");
    assert.isFalse(
      resolveClaudeUpdateRequiredModels(catalog, "1.0.0").some((model) => model.slug === MYTHOS),
    );
  });

  it("does not duplicate a gated model the manifest defines itself", () => {
    const base = manifest();
    const claude = base.providers!.claudeAgent!;
    const catalog = catalogFromManifest({
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...claude,
          models: [
            ...claude.models,
            {
              slug: MYTHOS,
              name: "Claude Mythos 5.1 (manifest)",
              status: "current",
              profile: claude.models[0]!.profile,
              adapter: { claudeCode: { minVersion: "3.2.0" } },
            },
          ],
        },
      },
    });
    assert.strictEqual(catalog.models.filter((entry) => entry.model.slug === MYTHOS).length, 1);
    // A manifest-defined entry is not gated, so it lists without an account.
    assert.isTrue(
      resolveClaudeModelsForVersion(catalog, "3.2.0").some((model) => model.slug === MYTHOS),
    );
  });
});

describe("opusplan", () => {
  const catalog = catalogFromManifest(manifest());

  it("lists for every account on a CLI that knows it, and not on an older one", () => {
    const slugs = (version: string) =>
      resolveClaudeModelsForVersion(catalog, version).map((model) => model.slug);
    assert.include(slugs("2.1.270"), "opusplan");
    assert.notInclude(slugs("2.1.269"), "opusplan");
    assert.isTrue(listUngatedClaudeModels(catalog).some((model) => model.slug === "opusplan"));
  });

  it("is sent to the SDK as the bare alias with a fixed 1M window", () => {
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opusplan" };
    assert.strictEqual(resolveClaudeCatalogApiModelId(catalog, selection), "opusplan");
    assert.strictEqual(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
  });

  it("keeps Opus-only controls off and treats ultrathink as prompt-injected", () => {
    const ids = getClaudeCatalogModelCapabilities(catalog, "opusplan").optionDescriptors?.map(
      (descriptor) => descriptor.id,
    );
    assert.deepStrictEqual(ids, ["effort"]);
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "ultrathink", "opusplan"), undefined);
  });
});
