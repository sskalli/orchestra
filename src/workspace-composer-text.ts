// Pure text edits for the prompt composers: list continuation, list indentation, and "/" skill completion.

/** Replace value[start, end) with text, then select [selectionStart, selectionEnd). */
export type TextEdit = { start: number; end: number; text: string; selectionStart: number; selectionEnd: number };

const listItem = /^([ \t]*)([-*]|\d{1,9}\.)( +)(\[[ xX]\] +)?/;
const indentUnit = "  ";

function lineStart(value: string, index: number) {
  return value.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(value: string, index: number) {
  const end = value.indexOf("\n", index);
  return end === -1 ? value.length : end;
}

/** Whether the line starting at `start` lies inside a ``` code block. */
function inCodeBlock(value: string, start: number) {
  return value.slice(0, start).split("\n").filter((line) => /^\s*```/.test(line)).length % 2 === 1;
}

/**
 * Shift+Enter inside a "- ", "* " or "N. " item starts the next item with the same indent (numbers increment,
 * task items start unchecked). On an item with no content it removes the marker, ending the list.
 * Returns undefined for a plain newline, including inside a code block.
 */
export function continueList(value: string, selectionStart: number, selectionEnd: number): TextEdit | undefined {
  const start = lineStart(value, selectionStart);
  const end = lineEnd(value, selectionStart);
  const match = listItem.exec(value.slice(start, end));
  if (!match || inCodeBlock(value, start)) return undefined;
  const [prefix, indent, marker, spacing, task] = match;
  // A caret inside the indent or marker is an ordinary newline.
  if (selectionStart < start + prefix.length) return undefined;
  const rest = value.slice(start + prefix.length, end);
  if (!rest.trim() && selectionEnd <= end) {
    return { start, end, text: "", selectionStart: start, selectionEnd: start };
  }
  const nextMarker = marker === "-" || marker === "*" ? marker : `${Number(marker.slice(0, -1)) + 1}.`;
  const text = `\n${indent}${nextMarker}${spacing}${task ? "[ ] " : ""}`;
  const caret = selectionStart + text.length;
  // Text moved to the new item drops its leading spaces, which the marker already provides.
  let replaceEnd = selectionEnd;
  while (replaceEnd < end && value[replaceEnd] === " ") replaceEnd++;
  return { start: selectionStart, end: replaceEnd, text, selectionStart: caret, selectionEnd: caret };
}

/**
 * Tab and Shift+Tab indent or outdent list items by two spaces when the caret or selection touches one.
 * Returns undefined when nothing would change (no list line, an outer item on Shift+Tab, or a code block),
 * so Tab and Shift+Tab keep moving focus.
 */
export function indentList(value: string, selectionStart: number, selectionEnd: number, outdent: boolean): TextEdit | undefined {
  const start = lineStart(value, selectionStart);
  // A selection that ends at the start of a line does not include that line.
  const lastIndex = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd;
  const end = lineEnd(value, Math.max(lastIndex, start));
  const lines = value.slice(start, end).split("\n");
  if (!lines.some((line) => listItem.test(line)) || inCodeBlock(value, start)) return undefined;
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
  if (!shifts.length) return undefined;
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

export type SkillMatch<T> = { skill: T; kind: "exact" | "prefix" | "substring" };

/**
 * Exact matches first, then prefix matches (including the part after a "plugin:" namespace),
 * then substring matches, each in list order. An empty query lists every skill as a prefix match.
 */
export function rankSkills<T extends { name: string }>(skills: readonly T[], query: string): SkillMatch<T>[] {
  const needle = query.toLowerCase();
  const ranked: Record<SkillMatch<T>["kind"], SkillMatch<T>[]> = { exact: [], prefix: [], substring: [] };
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    const local = name.slice(name.lastIndexOf(":") + 1);
    const kind = needle && (name === needle || local === needle) ? "exact"
      : name.startsWith(needle) || local.startsWith(needle) ? "prefix"
      : name.includes(needle) ? "substring" : undefined;
    if (kind) ranked[kind].push({ skill, kind });
  }
  return [...ranked.exact, ...ranked.prefix, ...ranked.substring];
}

export function filterSkills<T extends { name: string }>(skills: readonly T[], query: string): T[] {
  return rankSkills(skills, query).map(({ skill }) => skill);
}

/**
 * What Enter or Tab does with the menu open: complete the active skill only when it is a prefix match
 * or the user chose it with the arrow keys; a query that already names a skill exactly sends on Enter.
 */
export function slashKeyAction(match: SkillMatch<unknown> | undefined, query: string, key: "Enter" | "Tab", navigated: boolean) {
  if (!match) return "pass" as const;
  if (navigated) return "complete" as const;
  if (match.kind === "exact" && key === "Enter" && (match.skill as { name: string }).name.toLowerCase() === query.toLowerCase()) return "pass" as const;
  return match.kind === "substring" ? "pass" as const : "complete" as const;
}

export function applyEdit(value: string, edit: TextEdit) {
  return value.slice(0, edit.start) + edit.text + value.slice(edit.end);
}
