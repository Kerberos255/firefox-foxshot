import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const browserCandidates = [
  process.env.FOXSHOT_BROWSER_EXECUTABLE,
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe")
].filter(Boolean);
const executable = browserCandidates.find((candidate) => fs.existsSync(candidate));
if (!executable) {
  console.error("Set FOXSHOT_BROWSER_EXECUTABLE to a Chromium/Edge executable to run this browser regression.");
  process.exit(2);
}

const fixture = [
  "<!doctype html><html><head><style>body{height:2200px;margin:0;background:#d38f89;font:16px sans-serif}#modal-host{display:contents}</style></head><body>",
  "<div id='modal-host'></div><script>",
  "window.__copied=0;window.__captured=0;window.__pending={};window.__serial=0;",
  "window.__deliverCapture=(id,data)=>{window.__lastFrame=data;const fn=window.__pending[id];delete window.__pending[id];fn?.(data)};",
  "window.browser={i18n:{getMessage:()=>''},storage:{local:{get:async()=>({hideFloatingElements:true})}},",
  "runtime:{onMessage:{addListener:(fn)=>window.__foxshotDispatch=fn},sendMessage:async(msg)=>{",
  "if(msg.type==='foxshot.captureVisible'){const id=++window.__serial;window.__captured++;return new Promise(resolve=>{window.__pending[id]=resolve;window.foxshotCapture(String(id))})}",
  "if(msg.type==='foxshot.copyImage'){window.__copied++;return true}return true}}};",
  "const memory=document.getElementById('modal-host');const shadow=memory.attachShadow({mode:'open'});",
  "shadow.innerHTML='<style>dialog{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);margin:0;padding:0;width:690px;height:470px;border:0;border-radius:12px;background:#20364a;color:white}header{height:65px;background:#1d2835;padding:8px}main{margin-left:150px;overflow:auto;height:295px;background:#1a6e65}aside{float:left;width:130px}dialog::backdrop{background:rgba(0,0,0,.52)}</style><dialog id=story><header>Example modal</header><aside>导航菜单</aside><main class=modal-content><div style=height:1530px>Synthetic scrollable content</div></main></dialog>';",
  "window.__dialog=shadow.querySelector('dialog');window.__dialog.showModal();",
  "if(location.search.includes('plain')||location.search.includes('popover'))window.__dialog.close();",
  "if(location.search.includes('short'))shadow.querySelector('.modal-content>div').style.height='60px';",
  "if(location.search.includes('cssmodal')){window.__dialog.close();const layer=document.createElement('section');layer.setAttribute('role','dialog');layer.setAttribute('aria-modal','true');layer.style='position:fixed;top:110px;left:150px;width:680px;height:480px;background:#20364a;z-index:99999';const pane=document.createElement('main');pane.style='margin:80px 30px 0;height:290px;overflow:auto;background:#1a6e65';pane.innerHTML='<div style=height:1270px>Dialog main contents</div>';layer.append(pane);document.body.append(layer);window.__cssModal=layer;}",
  "if(location.search.includes('popover')){window.__userPop=document.createElement('div');window.__userPop.popover='auto';window.__userPop.style='background:#336699;color:white;padding:25px;width:300px;height:180px';window.__userPop.textContent='Popover content';document.body.append(window.__userPop);window.__userPop.showPopover()}",
  "</script><script src='/capture.js'></script></body></html>"
].join("");

const server = http.createServer((req, res) => {
  if (req.url === "/capture.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(fs.readFileSync(path.join(root, "content", "capture.js")));
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(fixture);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const site = "http://127.0.0.1:" + server.address().port;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "foxshot-browser-test-"));
const child = spawn(executable, [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(callback, maxMs = 18000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { const v = await callback(); if (v) return v; } catch {}
    await sleep(100);
  }
  throw new Error("Timed out waiting for browser condition");
}
let ws;
let cdp;
try {
  const port = await until(() => {
    const file = path.join(profile, "DevToolsActivePort");
    return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").split("\n")[0]) : null;
  });
  const target = await until(async () => {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list");
    return (await response.json()).find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  });
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  const events = new Map();
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) item.reject(new Error(msg.error.message));
      else item.resolve(msg.result || {});
    }
    if (msg.method === "Runtime.bindingCalled" && msg.params?.name === "foxshotCapture") {
      const requestId = msg.params.payload;
      void (async () => {
        const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        await cdp("Runtime.evaluate", {
          expression: "window.__deliverCapture(" + JSON.stringify(requestId) + "," + JSON.stringify("data:image/png;base64," + screenshot.data) + ")"
        });
      })().catch((error) => console.error("Screenshot bridge:", error));
    }
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Runtime.addBinding", { name: "foxshotCapture" });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 960, height: 700, deviceScaleFactor: 1, mobile: false });
  async function evaluate(expression) {
    const value = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result?.value;
  }
  async function load(suffix = "") {
    await cdp("Page.navigate", { url: site + "/fixture" + suffix });
    await until(async () => await evaluate("Boolean(window.__foxshotDispatch && window.__dialog)"));
  }
  async function sampleFrame(x, y) {
    return evaluate("(async()=>{const image=new Image();image.src=window.__lastFrame;await image.decode();const cv=document.createElement('canvas');cv.width=image.width;cv.height=image.height;const cx=cv.getContext('2d');cx.drawImage(image,0,0);return Array.from(cx.getImageData(" + x + "," + y + ",1,1).data).slice(0,3)})()");
  }
  const stageVisible = "Boolean(document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelector('.stage'))";
  const previewHeight = "document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelector('.result-preview')?.naturalHeight || 0";
  const mouse = async (type, x, y, buttons) => cdp("Input.dispatchMouseEvent", {
    type, x, y, button: type === "mousePressed" || type === "mouseReleased" ? "left" : "none", buttons: buttons ? 1 : 0, clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0
  });
  await load();
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'region'})");
  assert.equal(await evaluate(stageVisible), true, "Region layer did not open above modal");
  assert.equal(await evaluate("document.querySelector('[data-foxshot-ui-shell]')?.matches(':modal')"), true);
  await mouse("mouseMoved", 340, 260, false);
  await mouse("mousePressed", 340, 260, true);
  await mouse("mouseMoved", 680, 420, true);
  await mouse("mouseReleased", 680, 420, false);
   await until(async () => await evaluate("Boolean(document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelector('.toolbar'))"));
  await evaluate("Array.from(document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('.toolbar button')).find(x=>x.textContent==='复制').click()");
  await until(async () => await evaluate("window.__copied > 0"));
  const regionPixel = await sampleFrame(500, 350);
  assert.ok(regionPixel[1] > regionPixel[0], "Screenshot should contain green modal content, not red background: " + regionPixel);
  assert.equal(await evaluate("window.__dialog.open"), true);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-foxshot-ui]'))"), false);
  console.log("PASS region over Shadow DOM modal; original modal restored");

  await load();
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'full'})");
  const fullHeight = await until(async () => await evaluate(previewHeight), 30000);
  const desiredHeight = await evaluate("window.__dialog.querySelector('.modal-content').scrollHeight");
  assert.ok(Math.abs(fullHeight - desiredHeight) <= 3, "Full capture should follow modal scroller, not background: " + fullHeight + " vs " + desiredHeight);
  assert.equal(await evaluate("window.__dialog.open"), true);
  assert.equal(await evaluate("window.__dialog.querySelector('.modal-content').scrollTop"), 0);
  const fullPixel = await sampleFrame(500, 350);
  assert.ok(fullPixel[1] > fullPixel[0], "Full screenshot frame should preserve green modal content: " + fullPixel);
  console.log("PASS full-page foreground scroller, scroll restored, original modal retained");

  await load();
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'long'})");
  assert.equal(await evaluate(stageVisible), true);
  await mouse("mouseMoved", 360, 235, false);
  await mouse("mousePressed", 360, 235, true);
  await mouse("mouseMoved", 675, 400, true);
  await mouse("mouseReleased", 675, 400, false);
  await until(async () => await evaluate("Boolean(Array.from(document.querySelector('[data-foxshot-ui]')?.shadowRoot?.querySelectorAll('button') || []).find(x=>x.textContent==='完成'))"));
  await evaluate("Array.from(document.querySelector('[data-foxshot-ui]').shadowRoot.querySelectorAll('button')).find(x=>x.textContent==='完成').click()");
  const longHeight = await until(async () => await evaluate(previewHeight), 30000);
  assert.ok(longHeight > 25 && longHeight < 600, "Long capture unexpected height: " + longHeight);
  assert.equal(await evaluate("window.__dialog.open"), true);
  assert.equal(await evaluate("window.__dialog.querySelector('.modal-content').scrollTop"), 0);
  console.log("PASS long selection over modal, composed scroll target, original modal retained");

  await load();
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'region'})");
  await evaluate("window.__foxshotDispatch({type:'foxshot.cancel'})");
  assert.equal(await evaluate("window.__dialog.open"), true);
  assert.equal(await evaluate("document.querySelectorAll('[data-foxshot-ui-shell]').length"), 0);
  console.log("PASS cancel cleans up top-layer without closing page modal");

  await load("?popover=1");
  assert.equal(await evaluate("window.__userPop.matches(':popover-open')"), true);
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'region'})");
  assert.equal(await evaluate("document.querySelector('[data-foxshot-ui]')?.matches(':popover-open')"), true);
  assert.equal(await evaluate("window.__userPop.matches(':popover-open')"), true, "Original popover must remain open");
  await evaluate("window.__foxshotDispatch({type:'foxshot.cancel'})");
  assert.equal(await evaluate("window.__userPop.matches(':popover-open')"), true);
  console.log("PASS original auto popover remains open during manual popover capture overlay");

  await load("?plain=1");
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'region'})");
  assert.equal(await evaluate(stageVisible), true);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-foxshot-ui-shell]'))"), false);
  await evaluate("window.__foxshotDispatch({type:'foxshot.cancel'})");
  assert.equal(await evaluate("document.querySelectorAll('[data-foxshot-ui]').length"), 0);
  console.log("PASS normal pages retain existing non-modal overlay");

  await load("?short=1");
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'full'})");
  const shortHeight = await until(async () => await evaluate(previewHeight), 12000);
  assert.equal(shortHeight, 700, "A non-scrollable modal should produce one visible viewport frame");
  assert.equal(await evaluate("window.__dialog.open"), true);
  console.log("PASS non-scrollable foreground modal is captured without background scrolling");

  await load("?cssmodal=1");
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'full'})");
  const cssHeight = await until(async () => await evaluate(previewHeight), 30000);
  assert.equal(cssHeight, 1270, "Semantic CSS dialog should override background full-page scrolling");
  assert.equal(await evaluate("window.__cssModal.isConnected"), true);
  assert.equal(await evaluate("window.__cssModal.querySelector('main').scrollTop"), 0);
  console.log("PASS CSS role=dialog modal retained, internal scroller captured");

  await load();
  await evaluate("window.__foxshotDispatch({type:'foxshot.start',mode:'region'})");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(async () => !(await evaluate("Boolean(document.querySelector('[data-foxshot-ui-shell]'))")));
  assert.equal(await evaluate("window.__dialog.open"), true);
  console.log("PASS Escape closes FoxShot without closing foreground dialog");
  console.log("FoxShot modal browser regression passed");
} finally {
  ws?.close();
  child.kill();
  server.close();
  await sleep(100);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
