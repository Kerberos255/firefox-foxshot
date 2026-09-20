import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { firefox } from "playwright";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const captureSource = fs.readFileSync(path.join(root, "content/capture.js"), "utf8");
const report = { status: "running", tests: [], errors: [], artifacts: [] };
const artifacts = new Map();

function rowColor(y) {
  return [y & 255, (y >> 8) & 255, 97];
}

function fixtureHtml({ nested = false }) {
  const sectionHeight = nested ? 370 : 450;
  const sectionCount = 7;
  const totalHeight = sectionHeight * sectionCount;
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const start = index * sectionHeight;
    return `<section class="snap"><canvas data-start="${start}" width="${nested ? 420 : 480}" height="${sectionHeight}"></canvas></section>`;
  }).join("");

  return `<!doctype html>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #000; }
    ${nested
      ? `html, body { width:100%; height:100%; overflow:hidden; }
         #scroller { position:absolute; left:30px; top:40px; width:420px; height:620px; overflow-y:auto; overflow-x:hidden; scroll-snap-type:y mandatory; }
         #scroller > .snap { height:${sectionHeight}px; scroll-snap-align:start; scroll-snap-stop:always; }`
      : `html { scroll-snap-type:y mandatory; }
         body > .snap { height:${sectionHeight}px; scroll-snap-align:start; scroll-snap-stop:always; }`}
    canvas { display:block; width:100%; height:100%; }
  </style>
  ${nested ? `<div id="scroller">${sections}</div>` : sections}
  <script>
    for (const canvas of document.querySelectorAll("canvas")) {
      const start = Number(canvas.dataset.start);
      const ctx = canvas.getContext("2d", { alpha: false });
      const image = ctx.createImageData(canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y += 1) {
        const globalY = start + y;
        const r = globalY & 255;
        const g = (globalY >> 8) & 255;
        for (let x = 0; x < canvas.width; x += 1) {
          const p = (y * canvas.width + x) * 4;
          image.data[p] = r;
          image.data[p + 1] = g;
          image.data[p + 2] = 97;
          image.data[p + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
      // Keep x=10 untouched for the pixel oracle, but make the rest easy to
      // inspect by eye: large section labels and hard boundary markers expose
      // missing or repeated rows immediately.
      ctx.fillStyle = "rgba(0,0,0,.72)";
      ctx.fillRect(160, 24, Math.max(0, canvas.width - 180), 74);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 28px sans-serif";
      ctx.fillText("SECTION " + Math.floor(start / canvas.height), 180, 70);
      ctx.fillStyle = "#000";
      ctx.fillRect(160, 0, Math.max(0, canvas.width - 160), 3);
      ctx.fillStyle = "#fff";
      ctx.fillRect(160, 3, Math.max(0, canvas.width - 160), 3);
      ctx.fillStyle = "#000";
      ctx.fillRect(160, canvas.height - 6, Math.max(0, canvas.width - 160), 3);
      ctx.fillStyle = "#fff";
      ctx.fillRect(160, canvas.height - 3, Math.max(0, canvas.width - 160), 3);
    }
    window.__fixture = { totalHeight: ${totalHeight}, nested: ${nested ? "true" : "false"} };
  </script>`;
}

async function installFoxShotHarness(page) {
  await page.evaluate(() => {
    const listeners = [];
    const captureQueue = [];
    const captureResolvers = new Map();
    let nextCaptureId = 1;

    window.browser = {
      runtime: {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        async sendMessage(message) {
          if (message?.type === "foxshot.captureVisible") {
            return new Promise((resolve, reject) => {
              const id = nextCaptureId++;
              captureResolvers.set(id, { resolve, reject });
              captureQueue.push({ id });
            });
          }
          if (message?.type === "foxshot.copyImage") return true;
          if (message?.type === "foxshot.download") return 1;
          return undefined;
        }
      },
      storage: {
        local: {
          async get(defaults) { return { ...defaults }; }
        }
      }
    };

    window.__foxshotTakeCaptureRequest = () => captureQueue.shift() || null;
    window.__foxshotResolveCapture = (id, dataUrl) => {
      const pending = captureResolvers.get(id);
      if (!pending) return false;
      captureResolvers.delete(id);
      pending.resolve(dataUrl);
      return true;
    };
    window.__foxshotRejectCapture = (id, message) => {
      const pending = captureResolvers.get(id);
      if (!pending) return false;
      captureResolvers.delete(id);
      pending.reject(new Error(message));
      return true;
    };
    window.__foxshotDispatch = async (message) => {
      for (const listener of listeners) {
        const result = listener(message);
        if (result !== undefined) await result;
      }
    };
  });

  await page.addScriptTag({ content: captureSource });
}

async function pumpCaptureUntilResult(page, mode) {
  const deadline = Date.now() + 150000;
  let frames = 0;
  while (Date.now() < deadline) {
    const request = await page.evaluate(() => window.__foxshotTakeCaptureRequest());
    if (request) {
      console.log("FOXSHOT_E2E_FRAME_REQUEST", mode, request.id, frames);
      const png = await page.screenshot({ type: "png", timeout: 10000 });
      console.log("FOXSHOT_E2E_FRAME_READY", mode, request.id, png.length);
      const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
      await page.evaluate(({ id, dataUrl }) => window.__foxshotResolveCapture(id, dataUrl), { id: request.id, dataUrl });
      frames += 1;
      continue;
    }

    const state = await page.evaluate(() => {
      const image = document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelector(".result-preview");
      const hud = document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelector(".hud");
      return {
        done: Boolean(image?.complete && image.naturalWidth && image.naturalHeight),
        hud: hud?.textContent || "",
        scrollTop: window.scrollY,
        scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
        viewport: innerHeight,
        result: Boolean(document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelector(".result")),
        errorText: document.body?.innerText?.match(/(?:整页|长)截图失败[^\n]*/)?.[0] || ""
      };
    });
    if (state.done) {
      console.log("FOXSHOT_E2E_CAPTURED", mode, frames, JSON.stringify(state));
      return frames;
    }
    if (/失败/.test(state.hud) || state.errorText) throw new Error(state.hud || state.errorText);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${mode} capture timed out after ${frames} frames`);
}

async function driveCapture(page, mode) {
  console.log("FOXSHOT_E2E_START", mode);
  await page.evaluate((requestedMode) => {
    void window.__foxshotDispatch({ type: "foxshot.start", mode: requestedMode });
  }, mode);
  return pumpCaptureUntilResult(page, mode);
}

async function driveLongCapture(page, nested) {
  console.log("FOXSHOT_E2E_START", nested ? "long-nested" : "long-root");
  await page.evaluate(() => {
    void window.__foxshotDispatch({ type: "foxshot.start", mode: "long" });
  });
  await page.waitForFunction(() => Boolean(document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelector(".stage")));

  const startX = nested ? 70 : 50;
  const startY = nested ? 120 : 120;
  const endX = nested ? 400 : 430;
  const endY = nested ? 280 : 280;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();

  await page.waitForFunction(() => Boolean(document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelector("button[title='按当前范围生成长截图']")));

  const handle = await page.evaluate(() => {
    const el = document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelector(".handle.s");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!handle) throw new Error("long bottom handle not found");

  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, nested ? 652 : 690, { steps: 6 });
  await page.waitForTimeout(nested ? 700 : 850);
  await page.mouse.up();

  const range = await page.evaluate(({ nested, startY }) => {
    const root = document.querySelector("[data-foxshot-ui]")?.shadowRoot;
    const label = root?.querySelector(".size")?.textContent || "";
    const match = /×\s*(\d+)/.exec(label);
    const scroller = document.querySelector("#scroller");
    const rectTop = nested && scroller ? scroller.getBoundingClientRect().top : 0;
    return {
      height: match ? Number(match[1]) : 0,
      start: Math.round(startY - rectTop),
      label
    };
  }, { nested, startY });
  if (!range.height) throw new Error(`unable to read long range: ${range.label}`);

  await page.evaluate(() => {
    const button = [...(document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelectorAll("button") || [])]
      .find((node) => node.textContent === "完成");
    button?.click();
  });
  await pumpCaptureUntilResult(page, nested ? "long-nested" : "long-root");
  return range;
}

async function verifyResult(page, name, expectedHeight, expectedStart = 0) {
  await page.waitForFunction(() => {
    const image = document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelector(".result-preview");
    return Boolean(image?.complete && image.naturalWidth && image.naturalHeight);
  }, { timeout: 30000 });

  const result = await page.evaluate(({ expectedHeight, expectedStart }) => {
    const image = document.querySelector("[data-foxshot-ui]")?.shadowRoot?.querySelector(".result-preview");
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const x = Math.min(10, canvas.width - 1);
    const strip = ctx.getImageData(x, 0, 1, canvas.height).data;
    const mismatches = [];
    for (let y = 0; y < Math.min(expectedHeight, canvas.height); y += 1) {
      const p = y * 4;
      const globalY = expectedStart + y;
      const er = globalY & 255;
      const eg = (globalY >> 8) & 255;
      if (strip[p] !== er || strip[p + 1] !== eg || strip[p + 2] !== 97) {
        if (mismatches.length < 12) mismatches.push({ y, actual: [strip[p], strip[p + 1], strip[p + 2]], expected: [er, eg, 97] });
      }
    }
    const preview = document.createElement("canvas");
    const previewWidth = Math.min(320, canvas.width);
    const previewHeight = Math.max(1, Math.round(canvas.height * previewWidth / canvas.width));
    preview.width = previewWidth;
    preview.height = previewHeight;
    const pctx = preview.getContext("2d");
    pctx.drawImage(canvas, 0, 0, previewWidth, previewHeight);
    return {
      width: canvas.width,
      height: canvas.height,
      expectedHeight,
      expectedStart,
      mismatchCount: mismatches.length,
      mismatches,
      dataUrl: image.src,
      previewDataUrl: preview.toDataURL("image/jpeg", 0.72)
    };
  }, { expectedHeight, expectedStart });

  const pass = result.height === expectedHeight && result.mismatchCount === 0;
  const artifactName = `${name}.png`;
  const match = /^data:image\/png;base64,(.+)$/s.exec(result.dataUrl || "");
  if (match) {
    artifacts.set(artifactName, Buffer.from(match[1], "base64"));
    report.artifacts.push({ name: artifactName, path: `/artifacts/${artifactName}` });
  }
  const previewMatch = /^data:image\/jpeg;base64,(.+)$/s.exec(result.previewDataUrl || "");
  if (previewMatch) {
    const b64 = previewMatch[1];
    const chunkSize = 6000;
    const total = Math.ceil(b64.length / chunkSize);
    for (let index = 0; index < total; index += 1) {
      console.log("FOXSHOT_PREVIEW_CHUNK", name, index + 1, total, b64.slice(index * chunkSize, (index + 1) * chunkSize));
    }
  }
  const { dataUrl: _dataUrl, previewDataUrl: _preview, ...publicResult } = result;
  report.tests.push({ name, pass, ...publicResult });
  if (!pass) throw new Error(`${name} failed: ${JSON.stringify(publicResult)}`);
}

async function runCase(browser, name, nested) {
  const context = await browser.newContext({ viewport: { width: 480, height: 700 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (message) => console.log("FOXSHOT_PAGE_CONSOLE", name, message.type(), message.text()));
  page.on("pageerror", (error) => console.error("FOXSHOT_PAGE_ERROR", name, String(error?.stack || error)));
  try {
    await page.setContent(fixtureHtml({ nested }), { waitUntil: "load" });
    await installFoxShotHarness(page);
    await driveCapture(page, "full");
    const expectedHeight = await page.evaluate(() => window.__fixture.totalHeight);
    await verifyResult(page, name, expectedHeight);
  } finally {
    await context.close();
  }
}

async function runLongCase(browser, name, nested) {
  const context = await browser.newContext({ viewport: { width: 480, height: 700 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (message) => console.log("FOXSHOT_PAGE_CONSOLE", name, message.type(), message.text()));
  page.on("pageerror", (error) => console.error("FOXSHOT_PAGE_ERROR", name, String(error?.stack || error)));
  try {
    await page.setContent(fixtureHtml({ nested }), { waitUntil: "load" });
    await installFoxShotHarness(page);
    const range = await driveLongCapture(page, nested);
    await verifyResult(page, name, range.height, range.start);
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await firefox.launch({ headless: true });
  try {
    await runCase(browser, "root-scroll-snap", false);
    await runCase(browser, "nested-scroll-snap", true);
    await runLongCase(browser, "long-root-scroll-snap", false);
    await runLongCase(browser, "long-nested-scroll-snap", true);
    const builtPath = execFileSync("python3", ["tools/build.py"], { cwd: root, encoding: "utf8" }).trim();
    const xpiName = "FoxShot-1.1.0-long-capture-test.xpi";
    const xpiBuffer = fs.readFileSync(builtPath);
    artifacts.set(xpiName, xpiBuffer);
    report.artifacts.push({ name: xpiName, path: `/artifacts/${xpiName}` });
    const xpiB64 = xpiBuffer.toString("base64");
    const xpiChunkSize = 6000;
    const xpiTotal = Math.ceil(xpiB64.length / xpiChunkSize);
    for (let index = 0; index < xpiTotal; index += 1) {
      console.log("FOXSHOT_XPI_CHUNK", index + 1, xpiTotal, xpiB64.slice(index * xpiChunkSize, (index + 1) * xpiChunkSize));
    }
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.errors.push(String(error?.stack || error));
  } finally {
    await browser.close();
  }

  console.log("FOXSHOT_RENDER_E2E", JSON.stringify(report));
  if (report.status !== "PASS") {
    console.error(report.errors.join("\n"));
    process.exitCode = 1;
    return;
  }

  const port = Number(process.env.PORT || 10000);
  http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname.startsWith("/artifacts/")) {
      const name = decodeURIComponent(pathname.slice("/artifacts/".length));
      const png = artifacts.get(name);
      if (!png) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const contentType = name.endsWith(".xpi") ? "application/x-xpinstall" : "image/png";
      res.writeHead(200, {
        "content-type": contentType,
        "content-disposition": name.endsWith(".xpi") ? `attachment; filename="${name}"` : "inline",
        "cache-control": "no-store"
      });
      res.end(png);
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(report, null, 2));
  }).listen(port, "0.0.0.0", () => {
    console.log(`FOXSHOT_E2E_SERVER_READY ${port}`);
  });
}

await main();
