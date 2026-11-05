// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - plain Node release script that writes an AltStore source JSON; no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

export interface AltStoreSourceInput {
  readonly bundleId: string;
  readonly version: string;
  readonly ipaUrl: string;
  readonly ipaSize: number;
  readonly date: string;
  readonly name?: string | undefined;
  readonly iconUrl?: string | undefined;
  readonly sourceUrl?: string | undefined;
}

function requireText(label: string, value: string): string {
  if (value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requireHttpsUrl(label: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an https URL, got "${value}".`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must be an https URL, got "${value}".`);
  }
  return value;
}

export function buildAltStoreSource(input: AltStoreSourceInput) {
  const bundleId = requireText("bundle-id", input.bundleId);
  const version = requireText("version", input.version);
  const ipaUrl = requireHttpsUrl("ipa-url", input.ipaUrl);
  if (!Number.isInteger(input.ipaSize) || input.ipaSize <= 0) {
    throw new Error(`ipa-size must be a positive integer, got "${input.ipaSize}".`);
  }
  const parsedDate = new Date(requireText("date", input.date));
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`date must be a parseable ISO date, got "${input.date}".`);
  }
  const date = parsedDate.toISOString();
  const name = requireText("name", input.name ?? "T3 Code (fork)");
  const iconURL =
    input.iconUrl === undefined ? undefined : requireHttpsUrl("icon-url", input.iconUrl);
  const sourceURL =
    input.sourceUrl === undefined ? undefined : requireHttpsUrl("source-url", input.sourceUrl);

  const description = "Sideloadable builds of the T3 Code fork.";
  return {
    name,
    identifier: `${bundleId}.source`,
    subtitle: "T3 Code fork builds",
    description,
    ...(iconURL === undefined ? {} : { iconURL }),
    website: "https://github.com/JackTYM/t3code",
    ...(sourceURL === undefined ? {} : { sourceURL }),
    apps: [
      {
        name: "T3 Code",
        bundleIdentifier: bundleId,
        developerName: "JackTYM",
        subtitle: "A minimal GUI for coding agents",
        localizedDescription: description,
        ...(iconURL === undefined ? {} : { iconURL }),
        tintColor: "#000000",
        // Legacy AltStore clients read these instead of versions[].
        version,
        versionDate: date,
        downloadURL: ipaUrl,
        size: input.ipaSize,
        versions: [
          {
            version,
            buildVersion: version,
            date,
            size: input.ipaSize,
            downloadURL: ipaUrl,
            localizedDescription: `T3 Code ${version}`,
            minOSVersion: "17.0",
          },
        ],
        screenshots: [],
        appPermissions: { entitlements: [], privacy: {} },
      },
    ],
    news: [],
  };
}

const USAGE =
  'usage: make-altstore-source.ts --out <file> --bundle-id <id> --version <v> --ipa-url <https url> --ipa-size <bytes> --date <ISO date> [--name "T3 Code (fork)"] [--icon-url <url>] [--source-url <url>]';

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      "bundle-id": { type: "string" },
      version: { type: "string" },
      "ipa-url": { type: "string" },
      "ipa-size": { type: "string" },
      date: { type: "string" },
      name: { type: "string" },
      "icon-url": { type: "string" },
      "source-url": { type: "string" },
    },
  });
  const out = values.out;
  const bundleId = values["bundle-id"];
  const version = values.version;
  const ipaUrl = values["ipa-url"];
  const ipaSize = values["ipa-size"];
  const date = values.date;
  if (!out || !bundleId || !version || !ipaUrl || !ipaSize || !date) throw new Error(USAGE);
  const source = buildAltStoreSource({
    bundleId,
    version,
    ipaUrl,
    ipaSize: Number(ipaSize),
    date,
    name: values.name,
    iconUrl: values["icon-url"],
    sourceUrl: values["source-url"],
  });
  NodeFS.writeFileSync(out, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
