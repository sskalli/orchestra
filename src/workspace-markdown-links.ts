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
