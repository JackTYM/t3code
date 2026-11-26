// A form this short would match unrelated text, so only the value itself is hidden below this.
const ENCODED_FORM_MIN_LENGTH = 8;

const formsOf = (value: string): ReadonlyArray<string> => {
  const plain = [value, value.trim()].filter((form) => form !== "");
  const encoded =
    value.length < ENCODED_FORM_MIN_LENGTH
      ? []
      : plain.flatMap((form) => [Buffer.from(form).toString("base64"), encodeURIComponent(form)]);
  return [...new Set([...plain, ...encoded])];
};

/**
 * Replaces each value and its trimmed, base64 and URL-encoded forms with `[secret NAME]`, as plain
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
