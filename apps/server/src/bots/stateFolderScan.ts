// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { redactionSlack, redactSecrets } from "./redactSecrets.ts";

// A script's state folder is its own to write, so a value it wrote there is looked for after each
// run: a few small files, read a chunk at a time.
const MAX_FILES = 64;
const MAX_ENTRIES = 1024;
const MAX_DEPTH = 8;
const CHUNK_BYTES = 1024 * 1024;
// A larger file is not read to the end: it is treated as a hit and removed.
const MAX_FILE_BYTES = 64 * CHUNK_BYTES;

const isGone = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const decodesAsUtf8 = (bytes: Uint8Array) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/**
 * Replaces, in place, every value found in a script's state folder, and says whether any was found
 * or the folder could not be vouched for. It fails closed: what cannot be read, is too large, leaves
 * the folder, or is a hit in a file that is not small text counts as a hit, and that file is removed
 * instead of rewritten. Not seen: files past the first 64, and a value split across two files.
 */
export const hideInStateFolder = async (
  root: string,
  secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  /** For tests: runs after a directory is listed and before its entries are read. */
  hooks: { readonly listed?: (directory: string) => Promise<void> } = {},
): Promise<boolean> => {
  const overlap = redactionSlack(secrets) + 8;
  let realRoot: string;
  try {
    realRoot = await NodeFSP.realpath(root);
  } catch (cause) {
    return !isGone(cause);
  }
  let files = 0;
  let entries = 0;
  let found = false;
  const inside = (real: string) => real === realRoot || real.startsWith(realRoot + NodePath.sep);
  const remove = (target: string) => NodeFSP.unlink(target).catch(() => undefined);

  const readAt = async (handle: NodeFSP.FileHandle, position: number, length: number) => {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  };

  const hideIn = async (target: string) => {
    let handle: NodeFSP.FileHandle | undefined;
    try {
      // The link or swapped directory a lingering process may have put in its place.
      if (!inside(await NodeFSP.realpath(target))) {
        found = true;
        return;
      }
      handle = await NodeFSP.open(
        target,
        NodeFSP.constants.O_RDWR | NodeFSP.constants.O_NOFOLLOW | NodeFSP.constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      let hit = stat.size > MAX_FILE_BYTES;
      for (let position = 0; !hit && position < stat.size; position += CHUNK_BYTES - overlap) {
        const chunk = await readAt(handle, position, Math.min(CHUNK_BYTES, stat.size - position));
        hit = redactSecrets(chunk.toString(), secrets) !== chunk.toString();
        if (position + CHUNK_BYTES >= stat.size) break;
      }
      if (!hit) return;
      found = true;
      if (stat.size <= CHUNK_BYTES) {
        const bytes = await readAt(handle, 0, stat.size);
        if (decodesAsUtf8(bytes)) {
          await handle.truncate(0);
          await handle.write(redactSecrets(bytes.toString(), secrets), 0);
          return;
        }
      }
      await handle.close();
      handle = undefined;
      await remove(target);
    } catch (cause) {
      if (isGone(cause)) return;
      // Not read, so not known to be clean.
      found = true;
      await handle?.close().catch(() => undefined);
      handle = undefined;
      await remove(target);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  const walk = async (directory: string, depth: number): Promise<void> => {
    try {
      if (directory !== root && !inside(await NodeFSP.realpath(directory))) {
        found = true;
        return;
      }
      const listing = await NodeFSP.readdir(directory, { withFileTypes: true });
      await hooks.listed?.(directory);
      for (const entry of listing) {
        entries += 1;
        if (entries > MAX_ENTRIES || files >= MAX_FILES) return;
        const target = NodePath.join(directory, entry.name);
        // A `Dirent` from `readdir` is not a link's target: a link is neither a file nor a directory.
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH) await walk(target, depth + 1);
        } else if (entry.isFile()) {
          files += 1;
          await hideIn(target);
        }
      }
    } catch (cause) {
      if (!isGone(cause)) found = true;
    }
  };

  await walk(root, 0);
  return found;
};
