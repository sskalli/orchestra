import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Image types the chat may show from disk. Anything else is refused, so the endpoint never serves source files or secrets. */
export const localImageTypes: Readonly<Record<string, string>> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export const maxLocalImageBytes = 25 * 1024 * 1024;

export type LocalImage = { path: string; type: string; size: number };
export type LocalImageRefusal = { status: 400 | 403 | 404 | 413 | 415; reason: string };

function imageType(path: string) {
  const extension = extname(path).toLowerCase();
  return Object.hasOwn(localImageTypes, extension) ? localImageTypes[extension] : undefined;
}

function inside(root: string, path: string) {
  const offset = relative(root, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

/**
 * Resolves an image reference from an agent message to a file inside one of the allowed roots.
 * Relative references are tried against each root in order; absolute ones must already lie inside a root.
 * Both the requested path and its real path (after symlinks) must stay inside a root and name an image file.
 */
export async function resolveLocalImage(requested: string, roots: readonly string[]): Promise<LocalImage | LocalImageRefusal> {
  if (!requested || requested.length > 4096 || requested.includes("\0")) return { status: 400, reason: "Invalid image path" };
  let reference = requested;
  if (/^file:/i.test(reference)) {
    try {
      reference = fileURLToPath(reference);
    } catch {
      return { status: 400, reason: "Invalid image path" };
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(reference)) {
    return { status: 400, reason: "Only local image paths are served" };
  }
  if (!imageType(reference)) return { status: 415, reason: "Not an image file" };
  const allowed = [...new Set(roots.filter((root) => isAbsolute(root)).map((root) => resolve(root)))];
  if (!allowed.length) return { status: 403, reason: "No repositories are configured" };
  const realRoots = (await Promise.all(allowed.map((root) => realpath(root).catch(() => undefined))))
    .filter((root): root is string => root !== undefined);

  const candidates = isAbsolute(reference) ? [resolve(reference)] : allowed.map((root) => resolve(root, reference));
  let outside = false;
  for (const candidate of candidates) {
    if (!allowed.some((root) => inside(root, candidate))) {
      outside = true;
      continue;
    }
    const real = await realpath(candidate).catch(() => undefined);
    if (!real) continue;
    const type = imageType(real);
    if (!type || !realRoots.some((root) => inside(root, real))) {
      outside = true;
      continue;
    }
    const info = await stat(real).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > maxLocalImageBytes) return { status: 413, reason: "Image is too large" };
    return { path: real, type, size: info.size };
  }
  return outside ? { status: 403, reason: "Image is outside the configured repositories" } : { status: 404, reason: "Image not found" };
}
