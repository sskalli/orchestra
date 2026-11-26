import { constants } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
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
export type LoadedImage = LocalImage & { body: Buffer; etag: string };
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

async function realRootPaths(roots: readonly string[]) {
  return (await Promise.all(roots.filter((root) => isAbsolute(root)).map((root) => realpath(root).catch(() => undefined))))
    .filter((root): root is string => root !== undefined);
}

/**
 * Resolves and reads a local image. The file is opened without following a final symlink and without blocking
 * (a FIFO is refused instead of hanging), then checked and read through the same handle, so it cannot be swapped
 * between the check and the read. On Linux the opened file's real location is checked against the roots again.
 */
export async function loadLocalImage(requested: string, roots: readonly string[]): Promise<LoadedImage | LocalImageRefusal> {
  const image = await resolveLocalImage(requested, roots);
  if (!("path" in image)) return image;
  let handle;
  try {
    handle = await open(image.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { status: 404, reason: "Image not found" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: 404, reason: "Image not found" };
    if (info.size > maxLocalImageBytes) return { status: 413, reason: "Image is too large" };
    const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    if (opened !== undefined && (!imageType(opened) || !(await realRootPaths(roots)).some((root) => inside(root, opened)))) {
      return { status: 403, reason: "Image is outside the configured repositories" };
    }
    const body = await handle.readFile();
    if (body.length > maxLocalImageBytes) return { status: 413, reason: "Image is too large" };
    return { ...image, size: body.length, body, etag: `W/"${body.length.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"` };
  } finally {
    await handle.close();
  }
}
