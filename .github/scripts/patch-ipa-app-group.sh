#!/usr/bin/env bash
# Rewrites the app group an unsigned IPA reads its shared state from.
#
# Re-signing a sideloaded IPA under another bundle id needs a provisioning
# profile that carries the new group. The widget extension reads the Live
# Activity layout from that group's shared UserDefaults, so while the plists
# still name `group.com.t3tools.t3code` the card renders as an empty bar.
#
# Usage: patch-ipa-app-group.sh <input.ipa> <output.ipa> <app-group-id>
# Needs macOS: PlistBuddy edits the binary plists in place.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <input.ipa> <output.ipa> <app-group-id>" >&2
  exit 2
fi

input="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
output="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
group="$3"
plist_buddy=/usr/libexec/PlistBuddy

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q "$input" -d "$work"
app="$(find "$work/Payload" -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$app" ]]; then
  echo "No .app bundle in $input" >&2
  exit 1
fi

# Set fails on a missing key, which is what we want: a renamed key means the
# card is about to break again and the build should say so.
set_key() {
  local plist="$1" key="$2"
  "$plist_buddy" -c "Set :$key $group" "$plist" >/dev/null
}
set_key "$app/Info.plist" ExpoShareIntoAppGroupId
set_key "$app/Info.plist" ExpoWidgetsAppGroupIdentifier
set_key "$app/PlugIns/ExpoWidgetsTarget.appex/Info.plist" ExpoWidgetsAppGroupIdentifier
set_key "$app/PlugIns/expo-sharing-extension.appex/Info.plist" AppGroupId

rm -f "$output"
(cd "$work" && zip -qry "$output" Payload)

# Read the values back from the packaged file rather than trusting the edit.
check="$(mktemp -d)"
trap 'rm -rf "$work" "$check"' EXIT
unzip -q "$output" -d "$check"
packaged="$(find "$check/Payload" -maxdepth 1 -name '*.app' -print -quit)"
if grep -rl "group.com.t3tools.t3code" --include=Info.plist "$packaged" >/dev/null 2>&1; then
  echo "A plist in $output still names group.com.t3tools.t3code" >&2
  exit 1
fi
for entry in \
  "Info.plist:ExpoShareIntoAppGroupId" \
  "Info.plist:ExpoWidgetsAppGroupIdentifier" \
  "PlugIns/ExpoWidgetsTarget.appex/Info.plist:ExpoWidgetsAppGroupIdentifier" \
  "PlugIns/expo-sharing-extension.appex/Info.plist:AppGroupId"; do
  plist="${entry%%:*}"
  key="${entry##*:}"
  actual="$("$plist_buddy" -c "Print :$key" "$packaged/$plist")"
  if [[ "$actual" != "$group" ]]; then
    echo "$plist $key is '$actual', expected '$group'" >&2
    exit 1
  fi
  echo "$plist $key = $actual"
done
