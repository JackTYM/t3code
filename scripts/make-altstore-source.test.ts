// @effect-diagnostics nodeBuiltinImport:off - plain Node release script; the CLI test writes into a temp dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { buildAltStoreSource } from "./make-altstore-source.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

const base = {
  bundleId: "com.example.t3code",
  version: "0.1.6-fork.9",
  ipaUrl: "https://github.com/JackTYM/t3code/releases/download/v0.1.6-fork.9/T3Code.ipa",
  ipaSize: 12345678,
  date: "2026-11-05T12:00:00Z",
  iconUrl: "https://example.com/icon.png",
};

describe("buildAltStoreSource", () => {
  it("emits the source shape with defaults", () => {
    expect(buildAltStoreSource(base)).toEqual({
      name: "T3 Code (fork)",
      identifier: "com.example.t3code.source",
      subtitle: expect.any(String),
      description: expect.any(String),
      iconURL: "https://example.com/icon.png",
      website: "https://github.com/JackTYM/t3code",
      apps: [
        {
          name: "T3 Code",
          bundleIdentifier: "com.example.t3code",
          developerName: "JackTYM",
          subtitle: expect.any(String),
          localizedDescription: expect.any(String),
          iconURL: "https://example.com/icon.png",
          tintColor: "#000000",
          version: "0.1.6-fork.9",
          versionDate: "2026-11-05T12:00:00.000Z",
          downloadURL: base.ipaUrl,
          size: 12345678,
          versions: [
            {
              version: "0.1.6-fork.9",
              buildVersion: "0.1.6-fork.9",
              date: "2026-11-05T12:00:00.000Z",
              size: 12345678,
              downloadURL: base.ipaUrl,
              localizedDescription: expect.any(String),
              minOSVersion: "17.0",
            },
          ],
          screenshots: [],
          appPermissions: { entitlements: [], privacy: {} },
        },
      ],
      news: [],
    });
  });

  it("keeps the legacy fields and versions[] in agreement", () => {
    const app = buildAltStoreSource(base).apps[0];
    const latest = app?.versions[0];
    expect(app).toBeDefined();
    expect(latest).toMatchObject({
      version: app?.version,
      date: app?.versionDate,
      size: app?.size,
      downloadURL: app?.downloadURL,
    });
  });

  it("includes the optional name and source URL when given", () => {
    const source = buildAltStoreSource({
      ...base,
      name: "My Source",
      sourceUrl: "https://example.com/source.json",
    });
    expect(source).toMatchObject({
      name: "My Source",
      sourceURL: "https://example.com/source.json",
    });
  });

  it("puts the icon on the source and on every app, which Feather requires", () => {
    const source = buildAltStoreSource(base);
    expect(source.iconURL).toBe(base.iconUrl);
    expect(source.apps.every((app) => app.iconURL === base.iconUrl)).toBe(true);
  });

  it("omits the source URL when not given", () => {
    expect(buildAltStoreSource(base)).not.toHaveProperty("sourceURL");
  });

  it.each([
    [{ bundleId: " " }, /bundle-id/],
    [{ version: "" }, /version/],
    [{ ipaUrl: "http://example.com/a.ipa" }, /ipa-url.*https/],
    [{ ipaUrl: "not a url" }, /ipa-url.*https/],
    [{ ipaSize: 0 }, /ipa-size/],
    [{ ipaSize: 1.5 }, /ipa-size/],
    [{ ipaSize: Number.NaN }, /ipa-size/],
    [{ date: "yesterday-ish" }, /date/],
    [{ name: "" }, /name/],
    [{ iconUrl: "http://example.com/i.png" }, /icon-url/],
    [{ sourceUrl: "ftp://example.com/s.json" }, /source-url/],
  ])("rejects invalid input %j", (override, message) => {
    expect(() => buildAltStoreSource({ ...base, ...override })).toThrow(message);
  });
});

describe("make-altstore-source CLI", () => {
  const script = NodePath.join(import.meta.dirname, "make-altstore-source.ts");

  function run(args: string[]) {
    return NodeChildProcess.spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  }

  it("writes the source file", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "altstore-source-"));
    roots.push(root);
    const out = NodePath.join(root, "source.json");
    const result = run([
      "--out",
      out,
      "--bundle-id",
      base.bundleId,
      "--version",
      base.version,
      "--ipa-url",
      base.ipaUrl,
      "--ipa-size",
      String(base.ipaSize),
      "--date",
      base.date,
      "--icon-url",
      base.iconUrl,
      "--source-url",
      "https://example.com/source.json",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(NodeFS.readFileSync(out, "utf8"))).toEqual(
      JSON.parse(
        JSON.stringify(
          buildAltStoreSource({ ...base, sourceUrl: "https://example.com/source.json" }),
        ),
      ),
    );
  });

  it("fails with usage when required flags are missing", () => {
    const result = run(["--out", "/tmp/never-written.json"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage: make-altstore-source\.ts/);
  });
});
