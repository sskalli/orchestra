// Pure text edits for the prompt composers: list continuation, list indentation, and "/" skill completion.

/** Replace value[start, end) with text, then select [selectionStart, selectionEnd). */
export type TextEdit = { start: number; end: number; text: string; selectionStart: number; selectionEnd: number };

const listItem = /^([ \t]*)([-*]|\d{1,9}\.)( +)/;
const indentUnit = "  ";

function lineStart(value: string, index: number) {
  return value.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(value: string, index: number) {
  const end = value.indexOf("\n", index);
  return end === -1 ? value.length : end;
}

/**
 * Shift+Enter inside a "- ", "* " or "N. " item starts the next item with the same indent (numbers increment).
 * On an item with no content it removes the marker, ending the list. Returns undefined for a plain newline.
 */
export function continueList(value: string, selectionStart: number, selectionEnd: number): TextEdit | undefined {
  const start = lineStart(value, selectionStart);
  const end = lineEnd(value, selectionStart);
  const match = listItem.exec(value.slice(start, end));
  if (!match) return undefined;
  const [prefix, indent, marker, spacing] = match;
  // A caret inside the indent or marker is an ordinary newline.
  if (selectionStart < start + prefix.length) return undefined;
  const rest = value.slice(start + prefix.length, end);
  if (!rest.trim() && selectionEnd <= end) {
    return { start, end, text: "", selectionStart: start, selectionEnd: start };
  }
  const nextMarker = marker === "-" || marker === "*" ? marker : `${Number(marker.slice(0, -1)) + 1}.`;
  const text = `\n${indent}${nextMarker}${spacing}`;
  const caret = selectionStart + text.length;
  return { start: selectionStart, end: selectionEnd, text, selectionStart: caret, selectionEnd: caret };
}

/**
 * Tab and Shift+Tab indent or outdent list items by two spaces when the caret or selection touches one.
 * Returns undefined when no selected line is a list item, so Tab keeps moving focus.
 * An edit with unchanged text means the item is already at the outer level; the key is still consumed.
 */
export function indentList(value: string, selectionStart: number, selectionEnd: number, outdent: boolean): TextEdit | undefined {
  const start = lineStart(value, selectionStart);
  // A selection that ends at the start of a line does not include that line.
  const lastIndex = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd;
  const end = lineEnd(value, Math.max(lastIndex, start));
  const lines = value.slice(start, end).split("\n");
  if (!lines.some((line) => listItem.test(line))) return undefined;
  const shifts: { at: number; delta: number }[] = [];
  let offset = start;
  const changed = lines.map((line) => {
    const at = offset;
    offset += line.length + 1;
    if (!listItem.test(line)) return line;
    if (!outdent) {
      shifts.push({ at, delta: indentUnit.length });
      return indentUnit + line;
    }
    const removed = line.startsWith("\t") ? 1 : Math.min(/^ */.exec(line)![0].length, indentUnit.length);
    if (removed) shifts.push({ at, delta: -removed });
    return line.slice(removed);
  });
  // A selection that starts at a line start keeps covering the whole line, including its new indent.
  const map = (position: number, keepLineStart: boolean) => shifts.reduce((mapped, { at, delta }) =>
    delta > 0 ? mapped + (position > at || position === at && !keepLineStart ? delta : 0)
      : mapped - Math.max(0, Math.min(position - at, -delta)), position);
  const collapsed = selectionStart === selectionEnd;
  return { start, end, text: changed.join("\n"),
    selectionStart: map(selectionStart, !collapsed), selectionEnd: map(selectionEnd, false) };
}

/** The "/query" token the caret is in, when it starts the input or follows whitespace. */
export function slashToken(value: string, caret: number): { start: number; end: number; query: string } | undefined {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  if (value[start] !== "/" || caret <= start) return undefined;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end++;
  const query = value.slice(start + 1, caret);
  if (!/^[\w.:-]*$/.test(query)) return undefined;
  return { start, end, query };
}

/** Replaces the "/query" token with "/name " and places the caret after the space. */
export function completeSkill(value: string, token: { start: number; end: number }, name: string): TextEdit {
  const end = value[token.end] === " " ? token.end + 1 : token.end;
  const text = `/${name} `;
  const caret = token.start + text.length;
  return { start: token.start, end, text, selectionStart: caret, selectionEnd: caret };
}

/** Prefix matches first (including the part after a "plugin:" namespace), then substring matches, in list order. */
export function filterSkills<T extends { name: string }>(skills: readonly T[], query: string): T[] {
  const needle = query.toLowerCase();
  if (!needle) return [...skills];
  const prefix: T[] = [];
  const substring: T[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    const local = name.slice(name.lastIndexOf(":") + 1);
    if (name.startsWith(needle) || local.startsWith(needle)) prefix.push(skill);
    else if (name.includes(needle)) substring.push(skill);
  }
  return [...prefix, ...substring];
}

export function applyEdit(value: string, edit: TextEdit) {
  return value.slice(0, edit.start) + edit.text + value.slice(edit.end);
}
