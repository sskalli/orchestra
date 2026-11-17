import { copyFile } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["src/workspace.tsx"],
  bundle: true,
  jsx: "automatic",
  minify: true,
  loader: { ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  outdir: "dist/assets",
});
await copyFile("index.html", "dist/index.html");
await copyFile("src/orchestra-icon.svg", "dist/assets/orchestra-icon.svg");
