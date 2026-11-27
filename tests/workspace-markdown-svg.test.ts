import assert from "node:assert/strict";
import { test } from "node:test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { isSvgDocument, remarkSvgHtml, svgImageUrl, withSvgNamespaces } from "../src/workspace-markdown-svg.ts";

type Node = { type: string; value?: string; lang?: string; children?: Node[] };
function parse(markdown: string): Node {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkSvgHtml);
  return processor.runSync(processor.parse(markdown), markdown) as Node;
}
const shape = (node: Node): unknown => node.type === "code" ? { code: node.lang, value: node.value }
  : node.type === "text" ? node.value
  : node.children ? { [node.type]: node.children.map(shape) } : node.type === "html" ? { html: node.value } : node.type;

test("an SVG HTML block becomes an svg code block", () => {
  const svg = '<svg width="10" height="10">\n  <rect width="10" height="10"/>\n</svg>';
  assert.deepEqual(shape(parse(`Before\n\n${svg}\n\nAfter`)), { root: [
    { paragraph: ["Before"] }, { code: "svg", value: svg }, { paragraph: ["After"] },
  ] });
});

test("an SVG broken into several HTML blocks by blank lines is joined from the source", () => {
  const svg = '<svg viewBox="0 0 1 1">\n<g>\n\n<rect/>\n\n</g>\n</svg>';
  assert.deepEqual(shape(parse(svg)), { root: [{ code: "svg", value: svg }] });
});

test("inline SVG splits its paragraph and keeps the surrounding text", () => {
  assert.deepEqual(shape(parse('Inline <svg width="4"><circle r="2"/></svg> here')), { root: [
    { paragraph: ["Inline "] }, { code: "svg", value: '<svg width="4"><circle r="2"/></svg>' }, { paragraph: [" here"] },
  ] });
  assert.deepEqual(shape(parse('<svg width="4"><text>*not emphasis*</text></svg>')), { root: [
    { code: "svg", value: "<svg width=\"4\"><text>*not emphasis*</text></svg>" },
  ] });
});

test("SVG inside lists and quotes is detected, nested svg elements stay in one image", () => {
  const nested = "<svg><svg><rect/></svg><circle/></svg>";
  assert.deepEqual(shape(parse(`> ${nested}`)), { root: [{ blockquote: [{ code: "svg", value: nested }] }] });
  const list = parse("- item\n\n  <svg>\n  <rect/>\n  </svg>") as Node;
  assert.equal(list.children?.[0].children?.[0].children?.[1].type, "code");
});

test("other HTML and unterminated SVG stay raw HTML (stripped by skipHtml)", () => {
  const hasCode = (node: Node): boolean => node.type === "code" || !!node.children?.some(hasCode);
  for (const markdown of ["<div>no</div>", "<svg><rect/>", "<svg>\n<rect/>\n\ntext", "<svgfoo></svgfoo>", "a <svg> b", "</svg> <svg>"]) {
    assert.equal(hasCode(parse(markdown)), false, markdown);
  }
  assert.deepEqual(shape(parse("<div>no</div>")), { root: [{ html: "<div>no</div>" }] });
});

test("svg documents are recognized with an optional prolog", () => {
  assert.equal(isSvgDocument("<svg></svg>"), true);
  assert.equal(isSvgDocument('<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg>\n<svg xmlns="x"><g/></svg>\n'), true);
  assert.equal(isSvgDocument("<html><svg></svg></html>"), false);
  assert.equal(isSvgDocument("<svg></svg><script/>"), false);
  assert.equal(isSvgDocument("<note>xml</note>"), false);
});

test("missing namespaces are added so the SVG loads as an image", () => {
  assert.equal(withSvgNamespaces('<svg width="1"><rect/></svg>'), '<svg xmlns="http://www.w3.org/2000/svg" width="1"><rect/></svg>');
  assert.equal(withSvgNamespaces('<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="#a"/></svg>'),
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg"><use xlink:href="#a"/></svg>');
  assert.equal(withSvgNamespaces('<svg xmlns="a" xmlns:xlink="b"/>'), '<svg xmlns="a" xmlns:xlink="b"/>');
  assert.match(svgImageUrl("<svg></svg>"), /^data:image\/svg\+xml;charset=utf-8,%3Csvg%20xmlns%3D/);
});
