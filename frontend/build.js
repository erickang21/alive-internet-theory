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

// Only the tile decoration ships as a stylesheet; the rest is styled-components.
const buildStyles = () => {
  writeFileSync("dist/filter.css", readFileSync("src/content/filter.css", "utf8"));
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
