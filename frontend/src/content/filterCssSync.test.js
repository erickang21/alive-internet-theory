// filter.css and filterRenderer.js's inlined FILTER_CSS are necessarily two
// copies of the same rules: build.js only copies overlay.css into dist/ and the
// manifest only registers that one, so the renderer injects its own <style> tag.
// Neither file can be changed under the current scope, so this test is what
// stops the two copies from silently drifting apart.
//
// When the build is eventually updated to copy filter.css, delete FILTER_CSS,
// the injection, and this test together.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = (css) => stripComments(css).split(/\s+/).filter(Boolean);

test("filter.css and the inlined FILTER_CSS stay in sync", async () => {
  const css = await readFile(new URL("./filter.css", import.meta.url), "utf8");
  const js = await readFile(new URL("./filterRenderer.js", import.meta.url), "utf8");

  const match = js.match(/FILTER_CSS\s*=\s*`([\s\S]*?)`/);
  assert.ok(match, "filterRenderer.js should define a FILTER_CSS template string");

  assert.deepEqual(
    tokens(match[1]),
    tokens(css),
    "filter.css and FILTER_CSS have drifted - update both, or drop the inline copy once build.js copies filter.css",
  );
});
