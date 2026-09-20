import { build, context } from "esbuild";
import { readFileSync, watch as watchFiles, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    content: "src/content/index.jsx",
    background: "src/background/index.js",
    popup: "src/popup/index.jsx",
  },
  bundle: true,
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  format: "iife",
  outdir: "dist",
  sourcemap: true,
  target: "chrome120",
};

// Two stylesheets ship as files, because both have to apply before any script runs:
// the tile decoration and the popup's own layout. The rest is styled-components.
const styles = {
  "dist/filter.css": "src/content/filter.css",
  "dist/popup.css": "src/popup/popup.css",
};

const buildStyles = () => {
  for (const [out, source] of Object.entries(styles))
    writeFileSync(out, readFileSync(source, "utf8"));
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  buildStyles();
  watchFiles("src", { recursive: true }, (_event, file) => {
    if (file?.endsWith(".css")) buildStyles();
  });
  console.log("watching for changes...");
} else {
  await build(options);
  buildStyles();
}
