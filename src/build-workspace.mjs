import { copyFile, rm } from "node:fs/promises";
import { build } from "esbuild";

// Code splitting keeps lazily imported modules (Mermaid and its diagram types) out of the main bundle.
// Clear old hashed chunks first so dist/assets only holds the current build.
await rm("dist/assets", { recursive: true, force: true });
await build({
  entryPoints: ["src/workspace.tsx"],
  bundle: true,
  format: "esm",
  splitting: true,
  chunkNames: "chunk-[name]-[hash]",
  jsx: "automatic",
  minify: true,
  loader: { ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  outdir: "dist/assets",
});
await copyFile("index.html", "dist/index.html");
await copyFile("src/orchestra-icon.svg", "dist/assets/orchestra-icon.svg");
