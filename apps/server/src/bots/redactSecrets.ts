// A form this short would match unrelated text, so only the value itself is hidden below this.
const ENCODED_FORM_MIN_LENGTH = 8;

// Base64 turns 3 bytes into 4 characters, so where a value falls in a longer encoded text
// (`Basic base64("user:" + value)`) shifts its characters. For each of the 3 shifts, only the
// characters that depend on the value's own bytes alone are the same wherever it sits.
const ALIGNED_CORE_MIN_LENGTH = 12;
const alignedCores = (form: string): ReadonlyArray<string> => {
  const bytes = Buffer.from(form);
  return [0, 1, 2].flatMap((shift) => {
    const shifted = Buffer.concat([Buffer.alloc(shift), bytes]);
    const from = Math.ceil((8 * shift) / 6);
    const to = Math.floor((8 * (shift + bytes.length)) / 6);
    return (["base64", "base64url"] as const)
      .map((encoding) => shifted.toString(encoding).replace(/=+$/u, "").slice(from, to))
      .filter((core) => core.length >= ALIGNED_CORE_MIN_LENGTH);
  });
};

const computeForms = (value: string): ReadonlyArray<string> => {
  // `encodeURIComponent` throws on a lone surrogate; the original is kept so a script that printed
  // it as it was is still found.
  const wellFormed = value.toWellFormed();
  const plain = [value, wellFormed, value.trim(), wellFormed.trim()].filter((form) => form !== "");
  const encoded =
    value.length < ENCODED_FORM_MIN_LENGTH
      ? []
      : plain.flatMap((form) => {
          const base64 = Buffer.from(form).toString("base64");
          const percent = encodeURIComponent(form.toWellFormed());
          return [
            base64,
            base64.replace(/=+$/u, ""),
            Buffer.from(form).toString("base64url"),
            percent,
            percent.replace(/%[0-9A-F]{2}/gu, (match) => match.toLowerCase()),
            JSON.stringify(form).slice(1, -1),
            ...alignedCores(form),
          ];
        });
  return [...new Set([...plain, ...encoded])];
};

// A run asks for the same few values again for each output and each state file.
const FORMS_CACHE_MAX = 64;
const formsCache = new Map<string, ReadonlyArray<string>>();
const formsOf = (value: string): ReadonlyArray<string> => {
  const known = formsCache.get(value);
  if (known !== undefined) return known;
  const forms = computeForms(value);
  if (formsCache.size >= FORMS_CACHE_MAX) formsCache.clear();
  formsCache.set(value, forms);
  return forms;
};

/**
 * How many bytes longer than its value the longest form of any of these can be: the room a
 * captured output needs so that a form that starts inside the cap also ends inside what was read.
 */
export const redactionSlack = (secrets: ReadonlyArray<{ readonly value: string }>): number =>
  Math.max(
    0,
    ...secrets.flatMap(({ value }) => formsOf(value).map((form) => Buffer.byteLength(form))),
  );

/**
 * Replaces each value and its trimmed, base64, base64url, URL-encoded and JSON-escaped forms with `[secret NAME]`, as plain
 * text. Overlapping matches merge, so one secret inside another, or two running into each other,
 * leave no part behind. Split, reversed or hex shapes are not found: the reviewer covers those.
 */
export const redactSecrets = (
  text: string,
  secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string => {
  const matches = secrets
    .flatMap(({ name, value }) => formsOf(value).map((form) => ({ name, form })))
    .flatMap(({ name, form }) => {
      const found: Array<{ start: number; end: number; name: string }> = [];
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        found.push({ start: at, end: at + form.length, name });
      }
      return found;
    })
    .toSorted((a, b) => a.start - b.start || b.end - a.end);
  if (matches.length === 0) return text;

  let out = "";
  let cursor = 0;
  let group: { start: number; end: number; names: Array<string> } | undefined;
  const close = () => {
    if (group === undefined) return;
    out += text.slice(cursor, group.start) + group.names.map((name) => `[secret ${name}]`).join("");
    cursor = group.end;
  };
  for (const { start, end, name } of matches) {
    if (group !== undefined && start < group.end) {
      // Inside what is already hidden, it adds nothing to say; only a match that runs on does.
      if (end > group.end) {
        group.end = end;
        if (!group.names.includes(name)) group.names.push(name);
      }
    } else {
      close();
      group = { start, end, names: [name] };
    }
  }
  close();
  return out + text.slice(cursor);
};
