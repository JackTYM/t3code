// postal-mime only renders the parts a message has, so HTML-only mail arrives with no `text`.
// This reads the HTML as text in one forward pass: nothing is fetched, nothing is evaluated,
// and each character is looked at once, so hostile markup cannot make it slow.
const MAX_HTML_CHARS = 3_000_000;
const MAX_LINK_CHARS = 500;

// Content that is never text for the reader.
const DROPPED_ELEMENTS = new Set(["script", "style", "template", "title"]);
const LINE_BREAK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);

const NAMED_ENTITIES: Record<string, string> = {
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
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  zwnj: "\u200c",
  zwj: "\u200d",
  euro: "€",
  pound: "£",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi,
    (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
        return valid ? String.fromCodePoint(code) : "�";
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    },
  );
}

/** The end of the tag starting at `start`, stepping over quoted attribute values; -1 if unclosed. */
function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < html.length; i += 1) {
    const char = html[i]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function hrefOf(tag: string): string | undefined {
  const match = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const href = decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return /^https?:\/\//i.test(href) && href.length <= MAX_LINK_CHARS ? href : undefined;
}

// Zero-width and soft-hyphen padding that marketing mail uses to fill the preview line. Built from
// a string because the formatter rewrites escapes inside a regex literal into the raw characters.
const INVISIBLE = new RegExp("\\u00ad|\\u034f|[\\u200b-\\u200f\\u2060\\ufeff]", "g");

export function htmlToText(source: string): string {
  const html = source.length > MAX_HTML_CHARS ? source.slice(0, MAX_HTML_CHARS) : source;
  const out: string[] = [];
  let href: string | undefined;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const textEnd = lt === -1 ? html.length : lt;
    if (textEnd > i) out.push(decodeEntities(html.slice(i, textEnd).replace(/\s+/g, " ")));
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (!/[a-zA-Z/!?]/.test(next)) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end === -1) break;
    i = end + 1;

    const tag = html.slice(lt + 1, end);
    const closing = tag.startsWith("/");
    const name = /^\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name) continue;

    if (!closing && DROPPED_ELEMENTS.has(name)) {
      const close = new RegExp(`</${name}[\\s>/]`, "gi");
      close.lastIndex = i;
      const found = close.exec(html);
      if (!found) break;
      i = found.index;
      continue;
    }
    if (name === "a") {
      if (closing) {
        if (href) out.push(` (${href})`);
        href = undefined;
      } else {
        href = hrefOf(tag);
      }
    } else if (LINE_BREAK_TAGS.has(name)) {
      if (name !== "li") out.push("\n");
      else if (!closing) out.push("\n* ");
    } else if (name === "td" || name === "th") {
      out.push(" ");
    }
  }

  return out
    .join("")
    .replace(INVISIBLE, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
