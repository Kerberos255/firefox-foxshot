import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { firefox } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const captureSource = fs.readFileSync(path.join(root, "content/capture.js"), "utf8");
const report = { status: "running", tests: [], errors: [] };

function rowColor(y) {
  return [y & 255, (y >> 8) & 255, 97];
}

function fixtureHtml({ nested = false }) {
  const sectionHeight = nested ? 370 : 450;
  const sectionCount = nested ? 12 : 12;
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

async function driveCapture(page, mode) {
  console.log("FOXSHOT_E2E_START", mode);
  await page.evaluate((requestedMode) => {
    void window.__foxshotDispatch({ type: "foxshot.start", mode: requestedMode });
  }, mode);

  const deadline = Date.now() + 45000;
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
      const image = document.querySelector(".result-preview");
      const hud = document.querySelector(".hud");
      return {
        done: Boolean(image?.complete && image.naturalWidth && image.naturalHeight),
        hud: hud?.textContent || ""
      };
    });
    if (state.done) {
      console.log("FOXSHOT_E2E_CAPTURED", mode, frames);
      return;
    }
    if (/失败/.test(state.hud)) throw new Error(state.hud);
    if (frames === 0 && Date.now() + 1000 >= deadline) {
      const debug = await page.evaluate(() => ({
        loaded: Boolean(window.__foxshotLoaded),
        hasDispatch: typeof window.__foxshotDispatch === "function",
        hasTake: typeof window.__foxshotTakeCaptureRequest === "function",
        bodyHeight: document.body?.scrollHeight || 0,
        rootHeight: document.documentElement?.scrollHeight || 0,
        hud: document.querySelector(".hud")?.textContent || "",
        result: Boolean(document.querySelector(".result-preview"))
      }));
      console.log("FOXSHOT_E2E_TIMEOUT_DEBUG", mode, JSON.stringify(debug));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${mode} capture timed out after ${frames} frames`);
}

async function verifyResult(page, name, expectedHeight) {
  await page.waitForFunction(() => {
    const image = document.querySelector(".result-preview");
    return Boolean(image?.complete && image.naturalWidth && image.naturalHeight);
  }, { timeout: 30000 });

  const result = await page.evaluate(({ expectedHeight }) => {
    const image = document.querySelector(".result-preview");
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
      const er = y & 255;
      const eg = (y >> 8) & 255;
      if (strip[p] !== er || strip[p + 1] !== eg || strip[p + 2] !== 97) {
        if (mismatches.length < 12) mismatches.push({ y, actual: [strip[p], strip[p + 1], strip[p + 2]], expected: [er, eg, 97] });
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      expectedHeight,
      mismatchCount: mismatches.length,
      mismatches
    };
  }, { expectedHeight });

  const pass = result.height === expectedHeight && result.mismatchCount === 0;
  report.tests.push({ name, pass, ...result });
  if (!pass) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
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

async function main() {
  const browser = await firefox.launch({ headless: true });
  try {
    await runCase(browser, "root-scroll-snap", false);
    await runCase(browser, "nested-scroll-snap", true);
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
  http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(report, null, 2));
  }).listen(port, "0.0.0.0", () => {
    console.log(`FOXSHOT_E2E_SERVER_READY ${port}`);
  });
}

await main();
