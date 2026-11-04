// @effect-diagnostics nodeBuiltinImport:off - zip fixtures need zlib and no Effect equivalent exists.
import * as NodeZlib from "node:zlib";

export interface ZipSpec {
  readonly name: string;
  /** A number is that many zero bytes, which deflates to almost nothing. */
  readonly data: Buffer | string | number;
  /** Unix mode recorded in the external attributes; 0 records none. */
  readonly mode?: number;
  /** Lies about the uncompressed size in both headers. */
  readonly declaredSize?: number;
}

const deflatedZeros = new Map<number, { readonly packed: Buffer; readonly crc: number }>();

/** Minimal zip writer: the repo has no zip-building dependency and tests must not add one. */
export const buildZip = (specs: ReadonlyArray<ZipSpec>): Buffer => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const spec of specs) {
    const name = Buffer.from(spec.name, "utf8");
    let packed: Buffer;
    let crc: number;
    let size: number;
    let method: 0 | 8;
    if (typeof spec.data === "number") {
      const cached = deflatedZeros.get(spec.data) ?? {
        packed: NodeZlib.deflateRawSync(Buffer.alloc(spec.data)),
        crc: NodeZlib.crc32(Buffer.alloc(spec.data)),
      };
      deflatedZeros.set(spec.data, cached);
      ({ packed, crc } = cached);
      size = spec.data;
      method = 8;
    } else {
      const raw = Buffer.from(spec.data);
      packed = raw;
      crc = NodeZlib.crc32(raw);
      size = raw.length;
      method = 0;
    }
    const declared = spec.declaredSize ?? size;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((spec.mode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
};
