import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdit, completeSkill, continueList, filterSkills, indentList, slashToken } from "../src/workspace-composer-text.ts";
import type { TextEdit } from "../src/workspace-composer-text.ts";

/** Applies an edit at the "|" caret (or "[...]" selection) and renders the result with the new caret or selection. */
function run(marked: string, edit: (value: string, start: number, end: number) => TextEdit | undefined) {
  const start = marked.includes("[") ? marked.indexOf("[") : marked.indexOf("|");
  const value = marked.replace(/[|[\]]/g, "");
  const end = marked.includes("]") ? marked.indexOf("]") - 1 : start;
  const result = edit(value, start, end);
  if (!result) return undefined;
  const next = applyEdit(value, result);
  return result.selectionStart === result.selectionEnd
    ? next.slice(0, result.selectionStart) + "|" + next.slice(result.selectionStart)
    : next.slice(0, result.selectionStart) + "[" + next.slice(result.selectionStart, result.selectionEnd) + "]" + next.slice(result.selectionEnd);
}

test("Shift+Enter continues bullet and numbered lists with the same indent", () => {
  assert.equal(run("- first|", continueList), "- first\n- |");
  assert.equal(run("* first|", continueList), "* first\n* |");
  assert.equal(run("intro\n  - nested|\nafter", continueList), "intro\n  - nested\n  - |\nafter");
  assert.equal(run("9. ninth|", continueList), "9. ninth\n10. |");
  assert.equal(run("1.  wide|", continueList), "1.  wide\n2.  |");
  assert.equal(run("- split| here", continueList), "- split\n- | here");
  assert.equal(run("- [replace] me", continueList), "- \n- | me");
});

test("Shift+Enter on an empty item ends the list, and plain lines get an ordinary newline", () => {
  assert.equal(run("- one\n- |", continueList), "- one\n|");
  assert.equal(run("- one\n  3. |", continueList), "- one\n|");
  assert.equal(run("plain text|", continueList), undefined);
  assert.equal(run("-not a list|", continueList), undefined);
  assert.equal(run("|- before the marker", continueList), undefined);
  assert.equal(run("-| inside the marker", continueList), undefined);
  assert.equal(run("2024. year|", continueList), "2024. year\n2025. |");
});

test("Tab indents and Shift+Tab outdents list lines only", () => {
  const indent = (value: string, start: number, end: number) => indentList(value, start, end, false);
  const outdent = (value: string, start: number, end: number) => indentList(value, start, end, true);
  assert.equal(run("- a\n- b|", indent), "- a\n  - b|");
  assert.equal(run("  - b|", outdent), "- b|");
  assert.equal(run(" - b|", outdent), "- b|");
  assert.equal(run("\t- b|", outdent), "- b|");
  assert.equal(run("- b|", outdent), "- b|", "an outer item consumes Shift+Tab without changes");
  assert.equal(run("plain|", indent), undefined, "Tab keeps moving focus outside lists");
  assert.equal(run("[- a\ntext\n1. b]", indent), "[  - a\ntext\n  1. b]");
  assert.equal(run("  - a\n  - [b\n  - c]\n", outdent), "  - a\n- [b\n- c]\n");
  assert.equal(run("  |- a", outdent), "|- a");
  assert.equal(run("- a\n[- b\n]text", indent), "- a\n[  - b\n]text", "a selection ending at a line start leaves that line");
});

test("slash tokens open only at the input start or after whitespace", () => {
  assert.deepEqual(slashToken("/", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(slashToken("/rev", 4), { start: 0, end: 4, query: "rev" });
  assert.deepEqual(slashToken("please /co now", 10), { start: 7, end: 10, query: "co" });
  assert.deepEqual(slashToken("line\n/sim", 9), { start: 5, end: 9, query: "sim" });
  assert.deepEqual(slashToken("/review-pr", 3), { start: 0, end: 10, query: "re" });
  assert.equal(slashToken("a/b", 3), undefined);
  assert.equal(slashToken("https://x", 9), undefined);
  assert.equal(slashToken("/src/app", 8), undefined);
  assert.equal(slashToken("/done ", 6), undefined);
  assert.equal(slashToken("text", 4), undefined);
});

test("choosing a skill inserts /name and a space without duplicating spaces", () => {
  assert.equal(run("/re|", (value, start) => completeSkill(value, slashToken(value, start)!, "review")), "/review |");
  assert.equal(run("do /si| it", (value, start) => completeSkill(value, slashToken(value, start)!, "simplify")), "do /simplify |it");
  assert.equal(run("/r|ev", (value, start) => completeSkill(value, slashToken(value, start)!, "review")), "/review |");
});

test("skill filtering lists prefix matches before substring matches", () => {
  const skills = ["security-review", "review", "pdf:pdf", "anthropic-skills:docx", "code-review"].map((name) => ({ name }));
  assert.deepEqual(filterSkills(skills, "rev").map(({ name }) => name), ["review", "security-review", "code-review"]);
  assert.deepEqual(filterSkills(skills, "DOC").map(({ name }) => name), ["anthropic-skills:docx"]);
  assert.deepEqual(filterSkills(skills, "pdf").map(({ name }) => name), ["pdf:pdf"]);
  assert.equal(filterSkills(skills, "").length, skills.length);
  assert.deepEqual(filterSkills(skills, "zzz"), []);
});
