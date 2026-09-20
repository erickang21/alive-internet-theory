import { build, context } from "esbuild";
import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    content: "src/content/index.js",
    background: "src/background/index.js",
  },
  bundle: true,
  format: "iife",
  outdir: "dist",
  sourcemap: true,
  target: "chrome120",
};

// Every stylesheet the content script uses lives in src/content/ (overlay.css,
// filter.css, factCheckCard.css, and whatever gets added next) - copy the
// whole directory's .css files instead of hardcoding filenames one at a time,
// which is what let filter.css silently never reach dist/ before.
const CONTENT_CSS_DIR = "src/content";

const copyStatic = () => {
  const cssFiles = readdirSync(CONTENT_CSS_DIR).filter((name) => name.endsWith(".css"));
  for (const name of cssFiles) {
    cpSync(join(CONTENT_CSS_DIR, name), join("dist", name));
  }
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  copyStatic();
  console.log("watching for changes...");
} else {
  await build(options);
  copyStatic();
}
