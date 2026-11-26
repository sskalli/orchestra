import { copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { build } from "esbuild";

const outdir = "dist/assets";
const manifest = join(outdir, ".build-files.json");
const previous = await readFile(manifest, "utf8").then((text) => JSON.parse(text), () => []);

// Code splitting keeps lazily imported modules (Mermaid and its diagram types) out of the main bundle.
const result = await build({
  entryPoints: ["src/workspace.tsx"],
  bundle: true,
  format: "esm",
  splitting: true,
  chunkNames: "chunk-[name]-[hash]",
  jsx: "automatic",
  minify: true,
  metafile: true,
  loader: { ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  outdir,
});
await copyFile("index.html", "dist/index.html");
await copyFile("src/orchestra-icon.svg", join(outdir, "orchestra-icon.svg"));

// Prune chunks older than the previous build. The previous build's files stay, so a tab opened before this build
// can still load its lazy chunks (for example Mermaid) until it reloads.
const current = Object.keys(result.metafile.outputs).map((path) => basename(path));
const keep = new Set([...current, ...previous, "orchestra-icon.svg", basename(manifest)]);
for (const file of await readdir(outdir)) {
  if (!keep.has(file)) await rm(join(outdir, file), { force: true });
}
await writeFile(manifest, JSON.stringify(current));
