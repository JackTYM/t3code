// @effect-diagnostics nodeBuiltinImport:off -- a content hash of the file, not a security boundary.
import * as NodeCrypto from "node:crypto";

// Everything here treats the message as hostile: a sender controls every byte. Nothing throws on
// junk, every output is capped, bodies are never rendered, and nothing is fetched.

const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_HEADER_CHARS = 256 * 1024;
const MAX_HEADERS = 1000;
const MAX_PARTS = 200;
const MAX_DEPTH = 8;
// Encoded input read per body part. Decoded text is capped again at the contract's size.
const MAX_PART_INPUT_CHARS = 2 * 1024 * 1024;
const MAX_ADDRESS_CHARS = 320;
const MAX_RECIPIENTS = 100;
const MAX_ATTACHMENTS = 100;

const MAIL_BODY_MAX_CHARS = 200_000;
const SUBJECT_MAX_CHARS = 1_000;
const MESSAGE_ID_MAX_CHARS = 998;
const ATTACHMENT_NAME_MAX_CHARS = 255;

export interface MailHeader {
  /** Lower-cased. */
  readonly name: string;
  /** Unfolded, with any RFC 2047 words still encoded. */
  readonly value: string;
}

export interface ParsedMail {
  /** Every header, top to bottom. The receiver's own are above the sender's. */
  readonly headers: ReadonlyArray<MailHeader>;
  readonly messageId: string;
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  /** Addresses from the topmost `Delivered-To`, the one the receiving server added. */
  readonly deliveredTo: string | undefined;
  readonly subject: string;
  readonly sentAtMs: number | undefined;
  readonly bodyText: string;
  readonly attachmentNames: ReadonlyArray<string>;
  /** Mail composes and keeps drafts in the same folders as delivered mail. */
  readonly isDraft: boolean;
}

/**
 * The RFC 822 message inside an `.emlx` file: a line holding its byte length, the message, then a
 * property list Mail adds. A file without that first line is taken as a bare message.
 */
export function emlxMessage(file: Uint8Array): Uint8Array {
  let digits = 0;
  while (digits < 12 && digits < file.length && file[digits]! >= 0x30 && file[digits]! <= 0x39) {
    digits += 1;
  }
  const newline = file[digits];
  if (digits === 0 || (newline !== 0x0a && newline !== 0x0d)) {
    return file.subarray(0, MAX_MESSAGE_BYTES);
  }
  const length = Number(new TextDecoder().decode(file.subarray(0, digits)));
  const start = newline === 0x0d && file[digits + 1] === 0x0a ? digits + 2 : digits + 1;
  return file.subarray(start, Math.min(start + length, start + MAX_MESSAGE_BYTES, file.length));
}

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

function splitHeadBody(raw: string): readonly [head: string, body: string] {
  if (raw.startsWith("\r\n")) return ["", raw.slice(2)];
  if (raw.startsWith("\n")) return ["", raw.slice(1)];
  const lf = raw.indexOf("\n\n");
  const crlf = raw.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return [raw, ""];
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return [raw.slice(0, crlf), raw.slice(crlf + 4)];
  return [raw.slice(0, lf), raw.slice(lf + 2)];
}

function parseHeaderBlock(head: string): Array<MailHeader> {
  const headers: Array<{ name: string; value: string }> = [];
  for (const line of head.slice(0, MAX_HEADER_CHARS).split(/\r?\n/u)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      const last = headers[headers.length - 1];
      if (last !== undefined) last.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    // A mbox "From " line or other junk before the fields has no valid name and is skipped.
    if (colon <= 0 || /[\s\u0000- ]/u.test(line.slice(0, colon))) continue;
    if (headers.length >= MAX_HEADERS) break;
    headers.push({ name: line.slice(0, colon).toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

/** Headers only: enough to sort and to work out which account a message belongs to. */
export function readHeaders(message: Uint8Array): Array<MailHeader> {
  return parseHeaderBlock(splitHeadBody(latin1(message.subarray(0, MAX_HEADER_CHARS)))[0]);
}

const headerValue = (headers: ReadonlyArray<MailHeader>, name: string) =>
  headers.find((header) => header.name === name)?.value;

function decodeCharset(label: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder(label.trim().replace(/\*.*$/u, "").toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeQuotedPrintable(text: string, header: boolean): Uint8Array {
  const out: Array<number> = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charCodeAt(i);
    if (char === 0x3d /* = */) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
      // A soft line break: "=" at the end of a line joins it to the next.
      if (!header && text[i + 1] === "\r" && text[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (!header && text[i + 1] === "\n") {
        i += 1;
        continue;
      }
    }
    out.push(header && char === 0x5f /* _ */ ? 0x20 : char & 0xff);
  }
  return Uint8Array.from(out);
}

const ENCODED_WORD = /=\?([^?\s]{1,60})\?([bBqQ])\?([^?\s]{0,500})\?=/gu;

/** RFC 2047 words in a header value, decoded. Bytes outside ASCII are read as UTF-8. */
function decodeWords(value: string): string {
  const text = /[^\u0000-\u007f]/u.test(value)
    ? new TextDecoder("utf-8").decode(Buffer.from(value, "latin1"))
    : value;
  return text
    .replace(/(\?=)\s+(?==\?)/gu, "$1")
    .replace(ENCODED_WORD, (_word, charset: string, encoding: string, data: string) => {
      const bytes =
        encoding.toLowerCase() === "b"
          ? Buffer.from(data, "base64")
          : decodeQuotedPrintable(data, true);
      return decodeCharset(charset, bytes);
    });
}

const cleanLine = (value: string, max: number) =>
  truncate(
    value
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
    max,
  );

/** Cuts at `max` UTF-16 units without leaving half of a surrogate pair. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = /[\ud800-\udbff]/u.test(value[max - 1] ?? "") ? max - 1 : max;
  return value.slice(0, end);
}

export function stripCommentsAndQuotes(value: string): string {
  let text = value.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
  for (let i = 0; i < 8; i += 1) {
    const next = text.replace(/\([^()]*\)/gu, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

/** Bare, lower-cased addresses from an address-list header. Display names are dropped. */
function addressesOf(value: string | undefined): Array<string> {
  if (value === undefined) return [];
  const found: Array<string> = [];
  for (const part of stripCommentsAndQuotes(decodeWords(value)).split(",")) {
    const angle = /<([^<>]*)>/u.exec(part);
    const candidate =
      angle?.[1] ??
      /[^\s<>(),;:"]+@[^\s<>(),;:"]+/u.exec(part)?.[0] ??
      part.split(":").at(-1) ??
      "";
    const address = candidate
      .trim()
      .replace(/^mailto:/iu, "")
      .toLowerCase();
    if (address.includes("@") && address.length <= MAX_ADDRESS_CHARS && !/\s/u.test(address)) {
      found.push(address);
    }
    if (found.length >= MAX_RECIPIENTS) break;
  }
  return found;
}

interface ParamHeader {
  readonly main: string;
  readonly params: ReadonlyArray<readonly [key: string, value: string]>;
}

function parseParamHeader(value: string | undefined): ParamHeader {
  const pieces: Array<string> = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < (value ?? "").length; i += 1) {
    const char = value![i]!;
    if (char === "\\" && quoted) {
      current += char + (value![i + 1] ?? "");
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === ";" && !quoted) {
      pieces.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  pieces.push(current);
  const params: Array<readonly [string, string]> = [];
  for (const piece of pieces.slice(1)) {
    const equals = piece.indexOf("=");
    if (equals <= 0) continue;
    let raw = piece.slice(equals + 1).trim();
    if (raw.startsWith('"'))
      raw = raw
        .slice(1)
        .replace(/"[^"]*$/u, "")
        .replace(/\\(.)/gu, "$1");
    params.push([piece.slice(0, equals).trim().toLowerCase(), raw]);
  }
  return { main: (pieces[0] ?? "").trim().toLowerCase(), params };
}

function percentDecode(text: string): Uint8Array {
  const out: Array<number> = [];
  for (let i = 0; i < text.length; i += 1) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === "%" && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      out.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** A parameter's value, whether plain, RFC 2047 encoded, or RFC 2231 encoded or continued. */
function paramOf(header: ParamHeader, name: string): string | undefined {
  const plain = header.params.find(([key]) => key === name)?.[1];
  const continued = header.params
    .map(([key, value]) => ({
      match: new RegExp(`^${name}(?:\\*(\\d+))?(\\*)?$`, "u").exec(key),
      value,
    }))
    .filter(
      (entry): entry is { match: RegExpExecArray; value: string } =>
        entry.match !== null && (entry.match[1] !== undefined || entry.match[2] !== undefined),
    )
    .sort((a, b) => Number(a.match[1] ?? 0) - Number(b.match[1] ?? 0));
  if (continued.length === 0) return plain === undefined ? undefined : decodeWords(plain);
  let charset = "utf-8";
  const bytes: Array<number> = [];
  continued.forEach(({ match, value }, index) => {
    let piece = value;
    if (match[2] !== undefined) {
      if (index === 0) {
        const quote = /^([^']*)'[^']*'(.*)$/su.exec(value);
        if (quote !== null) {
          charset = quote[1] || "utf-8";
          piece = quote[2]!;
        }
      }
      bytes.push(...percentDecode(piece));
    } else {
      bytes.push(...Buffer.from(piece, "utf-8"));
    }
  });
  return decodeCharset(charset, Uint8Array.from(bytes));
}

interface Body {
  readonly text: string;
  readonly fromHtml: boolean;
}

interface WalkState {
  parts: number;
  readonly attachments: Array<string>;
}

function splitMultipart(body: string, boundary: string): Array<string> {
  const delimiter = `--${boundary}`;
  const parts: Array<string> = [];
  let start = -1;
  let from = 0;
  while (parts.length < MAX_PARTS) {
    let at = body.indexOf(delimiter, from);
    // A delimiter starts a line and ends the boundary: "--b" must not match "--b2".
    while (
      at !== -1 &&
      !(
        (at === 0 || body[at - 1] === "\n") &&
        /^(--|[\s]|$)/u.test(body.slice(at + delimiter.length, at + delimiter.length + 2))
      )
    ) {
      at = body.indexOf(delimiter, at + 1);
    }
    if (at === -1) break;
    if (start !== -1) {
      const end = body[at - 1] === "\n" ? (body[at - 2] === "\r" ? at - 2 : at - 1) : at;
      parts.push(body.slice(start, end));
    }
    if (body.startsWith("--", at + delimiter.length)) return parts;
    const lineEnd = body.indexOf("\n", at);
    if (lineEnd === -1) return parts;
    start = lineEnd + 1;
    from = start;
  }
  if (start !== -1) parts.push(body.slice(start));
  return parts;
}

function decodePartText(head: ReadonlyArray<MailHeader>, body: string, charset: string): string {
  const encoding = (headerValue(head, "content-transfer-encoding") ?? "").trim().toLowerCase();
  const input = body.length > MAX_PART_INPUT_CHARS ? body.slice(0, MAX_PART_INPUT_CHARS) : body;
  const bytes =
    encoding === "base64"
      ? Buffer.from(input.replace(/[^A-Za-z0-9+/=]/gu, ""), "base64")
      : encoding === "quoted-printable"
        ? decodeQuotedPrintable(input, false)
        : Buffer.from(input, "latin1");
  return decodeCharset(charset, bytes);
}

function walkPart(
  head: ReadonlyArray<MailHeader>,
  body: string,
  depth: number,
  state: WalkState,
): Body | undefined {
  state.parts += 1;
  if (state.parts > MAX_PARTS || depth > MAX_DEPTH) return undefined;
  const contentType = parseParamHeader(headerValue(head, "content-type") ?? "text/plain");
  const type = contentType.main || "text/plain";
  const disposition = parseParamHeader(headerValue(head, "content-disposition"));
  const filename = paramOf(disposition, "filename") ?? paramOf(contentType, "name");

  if (type.startsWith("multipart/")) {
    const boundary = paramOf(contentType, "boundary");
    if (boundary === undefined || boundary.length === 0) return undefined;
    const children = splitMultipart(body, boundary).flatMap((raw) => {
      const [childHead, childBody] = splitHeadBody(raw);
      const child = walkPart(parseHeaderBlock(childHead), childBody, depth + 1, state);
      return child === undefined || child.text.trim().length === 0 ? [] : [child];
    });
    if (children.length === 0) return undefined;
    if (type === "multipart/alternative") {
      // The plain alternative is what the sender wrote; the HTML one is the fallback.
      return children.find((child) => !child.fromHtml) ?? children[0];
    }
    return {
      text: children.map((child) => child.text).join("\n\n"),
      fromHtml: children.every((child) => child.fromHtml),
    };
  }

  const isText = type === "text/plain" || type === "text/html";
  if (disposition.main === "attachment" || (filename !== undefined && !type.startsWith("text/"))) {
    if (filename !== undefined && state.attachments.length < MAX_ATTACHMENTS) {
      const name = cleanLine(filename, ATTACHMENT_NAME_MAX_CHARS);
      if (name.length > 0) state.attachments.push(name);
    }
    return undefined;
  }
  if (!isText) return undefined;
  const text = decodePartText(head, body, paramOf(contentType, "charset") ?? "utf-8");
  return type === "text/html"
    ? { text: htmlToText(text), fromHtml: true }
    : { text, fromHtml: false };
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: String.fromCodePoint(0x2014),
  ndash: "\u2013",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  euro: "€",
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/giu, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? whole;
  });

const SKIPPED_ELEMENTS = new Set(["script", "style", "head", "template"]);
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "tr",
  "table",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "hr",
  "br",
]);
const MAX_TAG_CHARS = 10_000;
const MAX_HREF_CHARS = 300;

/**
 * Visible text of an HTML mail, by one linear scan. Scripts, styles and the head are dropped, tags
 * are never interpreted, and a link's address is kept after its text because a button's target is
 * often the point of the mail. Nothing is fetched.
 */
function htmlToText(html: string): string {
  const source = html.length > MAX_PART_INPUT_CHARS ? html.slice(0, MAX_PART_INPUT_CHARS) : html;
  // Only ASCII is folded, so indexes into `lower` are indexes into `source`.
  const lower = source.replace(/[A-Z]+/gu, (letters) => letters.toLowerCase());
  const limit = MAIL_BODY_MAX_CHARS * 2;
  let out = "";
  let i = 0;
  let linkStart = -1;
  let linkHref = "";
  while (i < source.length && out.length < limit) {
    const char = source[i]!;
    if (char !== "<") {
      const next = source.indexOf("<", i);
      const end = next === -1 ? source.length : next;
      out += decodeEntities(source.slice(i, end)).replace(/\s+/gu, " ");
      i = end;
      continue;
    }
    if (lower.startsWith("<!--", i)) {
      const end = lower.indexOf("-->", i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    const nameMatch = /^<(\/?)([a-z][a-z0-9]*)/u.exec(lower.slice(i, i + 40));
    if (nameMatch === null) {
      if (/^<[!?]/u.test(lower.slice(i, i + 2))) {
        const end = source.indexOf(">", i);
        i = end === -1 ? source.length : end + 1;
      } else {
        out += "<";
        i += 1;
      }
      continue;
    }
    const closing = nameMatch[1] === "/";
    const name = nameMatch[2]!;
    // The tag ends at the first ">" outside a quoted attribute value.
    let end = i + nameMatch[0].length;
    let quote = "";
    for (; end < source.length && end - i < MAX_TAG_CHARS; end += 1) {
      const c = source[end]!;
      if (quote !== "") {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const tag = source.slice(i, end);
    i = end + 1;
    if (!closing && SKIPPED_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      const closeEnd = close === -1 ? -1 : source.indexOf(">", close);
      i = closeEnd === -1 ? source.length : closeEnd + 1;
      continue;
    }
    if (name === "li") out += closing ? "" : "\n- ";
    else if (BLOCK_ELEMENTS.has(name)) out += "\n";
    else if ((name === "td" || name === "th") && closing) out += " ";
    if (name === "a") {
      if (!closing) {
        const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag);
        linkHref = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
        linkStart = out.length;
      } else if (linkStart !== -1) {
        const shown = out.slice(linkStart);
        if (
          /^https?:\/\//iu.test(linkHref) &&
          linkHref.length <= MAX_HREF_CHARS &&
          !shown.includes(linkHref)
        ) {
          out += ` (${linkHref})`;
        }
        linkStart = -1;
      }
    }
  }
  return out;
}

function tidyText(text: string, max: number): string {
  return truncate(
    text
      .slice(0, max * 2)
      .replace(/\r\n?/gu, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n[ \t]+/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
    max,
  );
}

function parseDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value.replace(/\([^)]*\)/gu, "").trim());
  return Number.isFinite(time) && time >= Date.UTC(1990, 0, 1) ? time : undefined;
}

function messageIdOf(headers: ReadonlyArray<MailHeader>, raw: Uint8Array): string {
  const value = headerValue(headers, "message-id") ?? "";
  const id = (/<([^<>\s]+)>/u.exec(value)?.[1] ?? value.trim().split(/\s/u)[0] ?? "").slice(
    0,
    MESSAGE_ID_MAX_CHARS,
  );
  if (id.length > 0) return id;
  // The same file always gets the same id, so the box still dedupes a message that has none.
  const digest = NodeCrypto.createHash("sha256")
    .update(raw.subarray(0, 1024 * 1024))
    .digest("hex");
  return `no-message-id-${digest.slice(0, 32)}@mail-app.invalid`;
}

/** Parses one message. Never throws: whatever cannot be read is left out. */
export function parseMail(message: Uint8Array): ParsedMail {
  const [head, body] = splitHeadBody(latin1(message));
  const headers = parseHeaderBlock(head);
  const state: WalkState = { parts: 0, attachments: [] };
  const walked = walkPart(headers, body, 0, state);
  const summary = summarizeHeaders(headers);
  return {
    headers,
    messageId: messageIdOf(headers, message),
    from: summary.from ?? "",
    to: addressesOf(headerValue(headers, "to")),
    cc: addressesOf(headerValue(headers, "cc")),
    deliveredTo: summary.deliveredTo,
    subject: cleanLine(decodeWords(headerValue(headers, "subject") ?? ""), SUBJECT_MAX_CHARS),
    sentAtMs: summary.sentAtMs,
    bodyText: tidyText(walked?.text ?? "", MAIL_BODY_MAX_CHARS),
    attachmentNames: state.attachments,
    isDraft: (headerValue(headers, "x-uniform-type-identifier") ?? "")
      .toLowerCase()
      .includes("com.apple.mail-draft"),
  };
}

// Mirrors infra/mail-worker/src/bulk.ts, which judges forwarded mail; keep the two rules
// identical. Only machine and marketing names: a real person's mail marked bulk would never wake
// the Bot. `mailer-daemon` is automated but not bulk.
const BULK_SENDER =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|newsletters?|marketing|notifications?)$/u;

/**
 * Whether a message is marketing or automated mail, from the sender's own headers and an obvious
 * no-reply sender. The sender writes all of these, so it sorts mail and vouches for nothing.
 */
export function isBulkMail(headers: ReadonlyArray<MailHeader>, from: string): boolean {
  for (const { name, value: raw } of headers) {
    const value = raw.trim();
    if ((name === "list-unsubscribe" || name === "list-id") && value !== "") return true;
    if (name === "precedence" && /^(?:bulk|list|junk)$/iu.test(value)) return true;
    if (name === "auto-submitted") {
      const kind = value.split(/[\s;]/u)[0]!.toLowerCase();
      if (kind !== "" && kind !== "no") return true;
    }
  }
  const at = from.lastIndexOf("@");
  return at > 0 && BULK_SENDER.test(from.slice(0, at).split("+")[0]!.toLowerCase());
}

/** What sorting and account detection need from a header block, without reading a body. */
export const summarizeHeaders = (headers: ReadonlyArray<MailHeader>) => ({
  from: addressesOf(headerValue(headers, "from"))[0],
  deliveredTo: addressesOf(headerValue(headers, "delivered-to"))[0],
  sentAtMs: parseDate(headerValue(headers, "date")),
});
