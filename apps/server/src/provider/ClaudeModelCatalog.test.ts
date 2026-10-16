import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import {
  formatClaudeVersionUpgradeMessage,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  listUngatedClaudeModels,
  resolveClaudeModelsForVersion,
  getClaudeCatalogModelCapabilities,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

/**
 * Test policy: adding or changing a real Claude model in model-manifest.json
 * must not add or update tests here. These synthetic fixtures cover resolver
 * behavior once. Add a test only when Claude adapter semantics change, such
 * as introducing a new compatibility rule or dispatch mapping type.
 */

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
                options: [{ id: "large", label: "Large", isDefault: true }],
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

describe("Claude model catalog", () => {
  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = resolveClaudeModelCatalog(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
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
    const catalog = resolveClaudeModelCatalog(input);
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

  it("rejects malformed adapter mappings", () => {
    const base = manifest();
    const malformed: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          profiles: {
            ...base.providers!.claudeAgent!.profiles,
            synthetic: {
              ...base.providers!.claudeAgent!.profiles.synthetic!,
              adapter: { claudeCode: { effortMap: { extreme: 123 } } },
            },
          },
        },
      },
    };
    assert.isFalse(hasValidClaudeManifestAdapters(malformed));
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(resolveClaudeModelCatalog(manifest()), [
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
              ],
            },
          ],
        },
      },
    ]);

    // The bare custom slug shadows the built-in alias, so it no longer resolves to it.
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"), undefined);

    // The entry with descriptors resolves user-defined effort ids and passes
    // them through untouched (no effortMap, no model suffix).
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
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
      ["claude-synthetic-next", "claude-custom-tuned"],
    );
  });

  describe("account-gated models", () => {
    const MYTHOS = "claude-mythos-5-1";
    const slugs = (
      catalog: ReturnType<typeof resolveClaudeModelCatalog>,
      ids?: ReadonlySet<string>,
    ) => resolveClaudeModelsForVersion(catalog, "3.2.0", ids).map((model) => model.slug);

    it("adds Mythos to any manifest but lists it only when the account reports it", () => {
      const catalog = resolveClaudeModelCatalog(manifest());
      assert.isFalse(slugs(catalog).includes(MYTHOS));
      assert.isFalse(slugs(catalog, new Set(["claude-fable-5-1"])).includes(MYTHOS));
      assert.isTrue(slugs(catalog, new Set([MYTHOS])).includes(MYTHOS));
      // Everyone else's models are unaffected by the account's list.
      assert.isTrue(slugs(catalog, new Set([MYTHOS])).includes("claude-synthetic-next"));
    });

    it("keeps Mythos resolvable by alias even while it is not listed", () => {
      const catalog = resolveClaudeModelCatalog(manifest());
      assert.strictEqual(resolveClaudeModelSlug(catalog, "mythos"), MYTHOS);
      const effort = getClaudeCatalogModelCapabilities(catalog, MYTHOS).optionDescriptors?.find(
        (descriptor) => descriptor.id === "effort",
      );
      assert.isDefined(effort);
    });

    it("excludes it from the ungated list and from upgrade prompts", () => {
      const catalog = resolveClaudeModelCatalog(manifest());
      assert.isFalse(listUngatedClaudeModels(catalog).some((model) => model.slug === MYTHOS));
      // 3.1.9 is older than both the synthetic model and Mythos; only the former may be named.
      assert.include(formatClaudeVersionUpgradeMessage(catalog, "2.0.0") ?? "", "Synthetic");
      assert.notInclude(formatClaudeVersionUpgradeMessage(catalog, "2.0.0") ?? "", "Mythos");
    });

    it("does not duplicate a Mythos entry the manifest already defines", () => {
      const withMythos = manifest();
      const claude = withMythos.providers!.claudeAgent!;
      const catalog = resolveClaudeModelCatalog({
        ...withMythos,
        providers: {
          ...withMythos.providers,
          claudeAgent: {
            ...claude,
            models: [
              ...claude.models,
              {
                slug: MYTHOS,
                name: "Claude Mythos 5.1 (manifest)",
                status: "current",
                profile: "synthetic",
                adapter: { claudeCode: { minVersion: "3.2.0" } },
              },
            ],
          },
        },
      });
      assert.strictEqual(catalog.models.filter((entry) => entry.model.slug === MYTHOS).length, 1);
      // The manifest's own definition is not gated.
      assert.isTrue(slugs(catalog).includes(MYTHOS));
    });
  });
});
