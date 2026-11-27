import assert from "node:assert/strict";
import { test } from "node:test";
import { chatImageSource, isWebLink, pathLinkText, rehypeFootnoteLabelPrefix } from "../src/workspace-markdown-links.ts";

test("only http and https addresses become links", () => {
  assert.equal(isWebLink("https://example.com/docs"), true);
  assert.equal(isWebLink("HTTP://example.com"), true);
  for (const href of ["src/workspace-chat.tsx:600", "/home/user/file.ts", "file:///etc/hosts", "mailto:a@b.c",
    "javascript:alert(1)", "//example.com", "#heading", "https://", ""]) {
    assert.equal(isWebLink(href), false, href);
  }
});

test("remote images must use https and local paths go through the workspace server", () => {
  assert.equal(chatImageSource("https://example.com/a.png"), "https://example.com/a.png");
  for (const src of ["http://example.com/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "//example.com/a.png", "", "  "]) {
    assert.equal(chatImageSource(src), undefined, src);
  }
  const local = new URL(chatImageSource("docs/my%20shot.png?v=2#top", "task-1")!, "http://local");
  assert.equal(local.pathname, "/api/image");
  assert.equal(local.searchParams.get("path"), "docs/my shot.png");
  assert.equal(local.searchParams.get("agent"), "task-1");
  assert.equal(new URL(chatImageSource("/abs/x.png")!, "http://local").searchParams.get("path"), "/abs/x.png");
  assert.equal(new URL(chatImageSource("file:///abs/my%20x.png")!, "http://local").searchParams.get("path"), "file:///abs/my%20x.png");
  assert.equal(chatImageSource("bad%E0%A4%A.png"), undefined);
});

test("path links show the target path, with a differing label as the tooltip", () => {
  assert.deepEqual(pathLinkText("src/foo.ts", "the foo module"), { text: "src/foo.ts", title: "the foo module" });
  assert.deepEqual(pathLinkText("src/foo.ts", "src/foo.ts"), { text: "src/foo.ts", title: undefined });
  assert.deepEqual(pathLinkText("/abs/my%20file.ts:12", "file"), { text: "/abs/my file.ts:12", title: "file" });
  assert.deepEqual(pathLinkText("file:///abs/x.ts", ""), { text: "/abs/x.ts", title: undefined });
  assert.deepEqual(pathLinkText("", "label only"), { text: "label only", title: undefined });
  assert.deepEqual(pathLinkText(undefined, "label only"), { text: "label only", title: undefined });
});

test("footnote labels are prefixed per message along with the references to them", () => {
  const tree = { type: "root", children: [
    { type: "element", properties: { href: "#m1-fn-1", ariaDescribedBy: ["footnote-label"] }, children: [] },
    { type: "element", properties: { id: "footnote-label", className: ["sr-only"] }, children: [] },
  ] };
  rehypeFootnoteLabelPrefix("m1-")(tree);
  assert.deepEqual(tree.children[0].properties.ariaDescribedBy, ["m1-footnote-label"]);
  assert.equal(tree.children[1].properties.id, "m1-footnote-label");
});
