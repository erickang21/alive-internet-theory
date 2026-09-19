import { build, context } from "esbuild";
import { cpSync } from "node:fs";

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

const copyStatic = () => {
  cpSync("src/content/overlay.css", "dist/overlay.css");
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
