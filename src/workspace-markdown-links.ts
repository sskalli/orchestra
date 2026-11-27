/** Only web addresses become clickable links in chat; paths and other schemes render as plain code. */
export function isWebLink(href: string) {
  return /^https?:\/\/[^\s/]/i.test(href);
}

/**
 * Maps a markdown image reference to the URL the chat loads it from, or undefined when the image is not allowed.
 * Remote images must use https. Local paths (relative, absolute, or file: URLs) go through the workspace server,
 * which only serves image files inside configured repositories and task worktrees.
 */
export function chatImageSource(src: string, agentId?: string) {
  const reference = src.trim();
  if (!reference) return undefined;
  if (/^https:\/\/[^\s/]/i.test(reference)) return reference;
  let path = reference;
  if (!/^file:/i.test(reference)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("//")) return undefined;
    // Drop cache-busting queries and fragments, then undo markdown's percent-encoding (such as spaces) to get the file name.
    try {
      path = decodeURI(reference.replace(/[?#].*$/, ""));
    } catch {
      return undefined;
    }
  }
  const query = new URLSearchParams({ path });
  if (agentId) query.set("agent", agentId);
  return `/api/image?${query}`;
}

/**
 * Text shown for a link whose target is not a web address: the target path itself, which is what the reader wants
 * to read or copy, with the link label as a tooltip when it says something else.
 */
export function pathLinkText(href: string | undefined, label: string) {
  let target = href?.trim() ?? "";
  if (/^file:\/\//i.test(target)) target = target.replace(/^file:\/\/(?:localhost)?/i, "");
  try {
    target = decodeURI(target);
  } catch {
    // Keep the encoded form when it is not valid percent-encoding.
  }
  if (!target) return { text: label, title: undefined };
  return { text: target, title: label.trim() && label.trim() !== target ? label.trim() : undefined };
}

type HastNode = { type: string; properties?: Record<string, unknown>; children?: HastNode[] };

/**
 * GFM footnotes always label their section with the id "footnote-label", even with a clobber prefix.
 * This rehype plugin prefixes that id and the references that point at it, so several messages can show footnotes.
 */
export function rehypeFootnoteLabelPrefix(prefix?: string) {
  return (tree: HastNode) => {
    if (!prefix) return;
    const label = `${prefix}footnote-label`;
    const visit = (node: HastNode) => {
      const properties = node.properties;
      if (properties) {
        if (properties.id === "footnote-label") properties.id = label;
        for (const key of ["ariaDescribedBy", "ariaLabelledBy"]) {
          const value = properties[key];
          if (Array.isArray(value)) properties[key] = value.map((entry) => entry === "footnote-label" ? label : entry);
          else if (value === "footnote-label") properties[key] = label;
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
