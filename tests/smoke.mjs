import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.0");
assert.equal(manifest.name, "__MSG_extensionName__");
assert.ok(manifest.permissions.includes("activeTab"));
assert.ok(manifest.permissions.includes("scripting"));
assert.ok(manifest.permissions.includes("downloads"));
assert.ok(manifest.permissions.includes("clipboardWrite"));
assert.ok(manifest.permissions.includes("storage"));
assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
assert.ok(!manifest.permissions.includes("<all_urls>"));
assert.ok(!manifest.permissions.includes("tabs"));
assert.equal(manifest.commands["capture-region"].suggested_key.default, "Alt+Shift+A");
assert.equal(manifest.options_ui.page, "options/options.html");

for (const file of [
  "background.js",
  "content/capture.js",
  "popup/popup.html",
  "popup/popup.js",
  "popup/popup.css",
  "options/options.html",
  "options/options.js",
  "options/options.css",
  "icons/icon.svg",
  "icons/icon-dark.svg",
  "icons/icon-light.svg",
  "_locales/zh_CN/messages.json",
  "_locales/en_US/messages.json",
  "PRIVACY.md",
  "LICENSE"
]) {
  assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
}

for (const locale of ["zh_CN", "en_US"]) {
  JSON.parse(fs.readFileSync(path.join(root, `_locales/${locale}/messages.json`), "utf8"));
}

const source = ["background.js", "content/capture.js", "popup/popup.js", "options/options.js"]
  .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
  .join("\n");
assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket)\b/.test(source), "runtime source should not use remote network APIs");
assert.ok(!/[A-Z]:\\/.test(source), "runtime source should not contain Windows absolute paths");
assert.ok(!/api[_-]?key|password\s*=|bearer\s+[a-z0-9._-]+/i.test(source), "possible secret-like string found");


const captureSource = fs.readFileSync(path.join(root, "content/capture.js"), "utf8");
assert.match(captureSource, /setPointerCapture/, "selection interactions should use pointer capture");
assert.match(captureSource, /ui\.shadow\.addEventListener\("pointerup"/, "pointerup should be handled at the shadow-root level");
assert.match(captureSource, /settleScroller/, "capture should use stable scroll settling");
assert.match(captureSource, /findScrollerAt/, "capture should detect nested scroll containers");
assert.match(captureSource, /RED_FORBIDDEN_CURSOR/, "selection UI should provide a visible forbidden cursor outside the selection");
assert.match(captureSource, /pixelateStroke/, "mosaic should be implemented as a brush stroke");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
assert.match(backgroundSource, /browser\.commands\.onCommand/, "region shortcut command handler missing");
assert.match(backgroundSource, /initializeShortcut/, "shortcut initialization/migration missing");

assert.ok(!backgroundSource.includes("foxshot.captureRect"), "off-screen rect capture should not be used");
assert.match(backgroundSource, /browser\.clipboard\.setImageData/, "Firefox image clipboard API missing");
assert.match(backgroundSource, /URL\.createObjectURL/, "PNG saving should use Blob/Object URLs");
assert.match(backgroundSource, /new Blob/, "PNG saving should convert image data to a Blob");
assert.match(captureSource, /image\.crossOrigin = "anonymous"/, "screenshot images should use CORS-safe loading");
assert.match(captureSource, /frames\.push/, "stitching should retain original screenshot frames");
assert.ok(!captureSource.includes("chunks.push(chunk)"), "stitching should avoid canvas-to-canvas segment composition");
assert.ok(!captureSource.includes("captureRectWithoutUI"), "direct off-screen rect capture helper should be removed");
assert.match(captureSource, /runLongAutoScroll/, "drag-to-extend auto-scroll interaction missing");
assert.ok(!captureSource.includes("手动滚动"), "legacy manual scroll capture UI should be removed");
assert.ok(!captureSource.includes("自动滚动并采集"), "legacy automatic sampling UI should be removed");

console.log("FoxShot smoke checks passed");
