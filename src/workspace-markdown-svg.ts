/** SVG sources larger than this are shown as code instead of an image. */
export const maxSvgSourceLength = 1024 * 1024;

const svgDocument = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?=[\s>/])[\s\S]*<\/svg\s*>\s*$/i;

/** True when the source is a single SVG document: an optional XML prolog, then one <svg>…</svg> root. */
export function isSvgDocument(source: string) {
  return svgDocument.test(source) && countSvgTags(source).open > 0;
}

function countSvgTags(source: string) {
  return { open: source.match(/<svg(?=[\s>/])/gi)?.length ?? 0, close: source.match(/<\/svg\s*>/gi)?.length ?? 0 };
}

/**
 * SVG written inline in HTML usually omits its namespaces, which an SVG loaded as an image requires.
 * Adds xmlns (and xmlns:xlink when xlink attributes are used) to the root <svg> tag when missing.
 */
export function withSvgNamespaces(source: string) {
  return source.replace(/<svg(?=[\s>/])([^>]*)>/i, (tag, attributes: string) => {
    let added = "";
    if (!/\sxmlns\s*=/.test(attributes)) added += ' xmlns="http://www.w3.org/2000/svg"';
    if (/\sxlink:/.test(source) && !/\sxmlns:xlink\s*=/.test(attributes)) added += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    return added ? `<svg${added}${attributes}>` : tag;
  });
}

/** An image URL for an SVG source. Loaded through <img>, the SVG cannot run scripts or fetch external resources. */
export function svgImageUrl(source: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withSvgNamespaces(source.trim()))}`;
}

type Point = { offset?: number };
type MdNode = {
  type: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  children?: MdNode[];
  position?: { start: Point & Record<string, unknown>; end: Point & Record<string, unknown> };
};

const startsSvg = (node: MdNode) => node.type === "html" && /^\s*<svg(?=[\s>/])/i.test(node.value ?? "");

/** Finds the sibling that closes an SVG opened by children[start], returning its index and the raw source between them. */
function svgRun(children: MdNode[], start: number, source: string) {
  const from = children[start].position?.start.offset;
  if (from === undefined) return undefined;
  for (let index = start; index < children.length && index < start + 2000; index++) {
    const to = children[index].position?.end.offset;
    if (to === undefined) return undefined;
    // Stop scanning far past the size limit; such a run stays stripped like other HTML.
    if (to - from > maxSvgSourceLength * 2) return undefined;
    const raw = source.slice(from, to);
    const { open, close } = countSvgTags(raw);
    if (close >= open && /<\/svg\s*>\s*$/i.test(raw)) return { end: index, raw: raw.trim() };
  }
  return undefined;
}

function svgCode(raw: string, first: MdNode, last: MdNode): MdNode {
  return {
    type: "code", lang: "svg", meta: null, value: raw,
    position: first.position && last.position ? { start: first.position.start, end: last.position.end } : undefined,
  };
}

const blank = (node: MdNode) => (node.type === "text" && !node.value?.trim()) || node.type === "break";

/** Splits a paragraph around inline SVG runs. Returns undefined when it holds none. */
function splitParagraph(paragraph: MdNode, source: string): MdNode[] | undefined {
  const children = paragraph.children ?? [];
  const parts: MdNode[] = [];
  let pending: MdNode[] = [];
  let found = false;
  const flush = () => {
    if (pending.some((node) => !blank(node))) parts.push({ type: "paragraph", children: pending });
    pending = [];
  };
  for (let index = 0; index < children.length; index++) {
    const run = startsSvg(children[index]) ? svgRun(children, index, source) : undefined;
    if (!run) {
      pending.push(children[index]);
      continue;
    }
    found = true;
    flush();
    parts.push(svgCode(run.raw, children[index], children[run.end]));
    index = run.end;
  }
  flush();
  return found ? parts : undefined;
}

/**
 * Remark plugin: raw <svg>…</svg> markup in a message, written as an HTML block or inline, becomes an ```svg code
 * block so the chat can show it as an image. Every other raw HTML node is left alone (and stripped by skipHtml).
 */
export function remarkSvgHtml() {
  return (tree: MdNode, file: { toString(): string }) => {
    const source = String(file);
    const visit = (parent: MdNode) => {
      const children = parent.children;
      if (!children) return;
      for (let index = 0; index < children.length; index++) {
        const node = children[index];
        if (startsSvg(node)) {
          const run = svgRun(children, index, source);
          if (run) {
            children.splice(index, run.end - index + 1, svgCode(run.raw, node, children[run.end]));
            continue;
          }
        }
        if (node.type === "paragraph") {
          const parts = splitParagraph(node, source);
          if (parts) {
            children.splice(index, 1, ...parts);
            index += parts.length - 1;
            continue;
          }
        }
        visit(node);
      }
    };
    visit(tree);
  };
}
