/* SPDX-License-Identifier: MIT */
"use strict";

(() => {
  if (window.__foxshotLoaded) return;
  window.__foxshotLoaded = true;

  const MAX_OUTPUT_HEIGHT = 32000;
  const MIN_SELECTION = 12;
  const NS = "http://www.w3.org/2000/svg";
  const RED_FORBIDDEN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="10" fill="white" fill-opacity=".92" stroke="#ff2d2d" stroke-width="3"/><path d="M7 21 21 7" stroke="#ff2d2d" stroke-width="3" stroke-linecap="round"/></svg>'
  )}") 14 14, not-allowed`;

  let ui = null;
  let selection = null;
  let shapes = [];
  let redoShapes = [];
  let tool = "move";
  let drawColor = "#ff4d4f";
  let lineWidth = 3;
  let interaction = null;
  let longSession = null;
  let capturedPointerId = null;
  let capturedPointerOwner = null;
  let lastPointer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const point = (event) => ({ x: event.clientX, y: event.clientY });
  const inside = (p, r) => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

  function normalizeRect(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      // Firefox can otherwise mark a canvas fed by a screenshot data URL as
      // write-only inside an extension content script (SecurityError).
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  async function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Unable to encode PNG")), "image/png");
    });
  }

  function destroyUI() {
    releasePointer();
    if (ui?.host?.isConnected) ui.host.remove();
    ui = null;
    interaction = null;
  }

  function mountBase() {
    destroyUI();
    const host = document.createElement("div");
    host.dataset.foxshotUi = "true";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .stage { position:fixed; inset:0; cursor:crosshair; pointer-events:auto; font:13px/1.2 system-ui,sans-serif; color:#fff; }
      .selection { position:fixed; pointer-events:none; border:2px solid #ff4d4f; box-shadow:0 0 0 99999px rgba(0,0,0,.48); background:transparent; }
      .selection.moving { cursor:move; }
      .size { position:absolute; left:6px; top:-27px; padding:4px 7px; border-radius:5px; background:rgba(20,20,20,.85); color:#fff; white-space:nowrap; }
      .handle { position:absolute; width:10px; height:10px; border:2px solid #fff; background:#ff4d4f; border-radius:2px; pointer-events:auto; }
      .nw{left:-6px;top:-6px;cursor:nwse-resize}.n{left:50%;top:-6px;transform:translateX(-50%);cursor:ns-resize}.ne{right:-6px;top:-6px;cursor:nesw-resize}
      .e{right:-6px;top:50%;transform:translateY(-50%);cursor:ew-resize}.se{right:-6px;bottom:-6px;cursor:nwse-resize}.s{left:50%;bottom:-6px;transform:translateX(-50%);cursor:ns-resize}
      .sw{left:-6px;bottom:-6px;cursor:nesw-resize}.w{left:-6px;top:50%;transform:translateY(-50%);cursor:ew-resize}
      .draw-layer { position:fixed; inset:0; overflow:visible; pointer-events:none; }
      .toolbar { position:fixed; display:flex; align-items:center; gap:4px; padding:6px; border-radius:9px; background:rgba(28,28,32,.96); box-shadow:0 4px 18px rgba(0,0,0,.35); pointer-events:auto; user-select:none; max-width:calc(100vw - 16px); flex-wrap:wrap; }
      .toolbar button,.toolbar select,.toolbar input { font:13px system-ui,sans-serif; }
      .toolbar button { width:30px; height:30px; padding:0; border:0; border-radius:6px; background:transparent; color:#fff; cursor:pointer; }
      .toolbar button:hover,.toolbar button.active { background:rgba(255,255,255,.16); }
      .toolbar button.wide { width:auto; padding:0 9px; }
      .toolbar .sep { width:1px; height:22px; background:rgba(255,255,255,.18); margin:0 2px; }
      .toolbar input[type=color] { width:28px; height:28px; padding:2px; border:0; background:transparent; }
      .toolbar select { height:28px; border:0; border-radius:5px; background:#444; color:#fff; }
      .hint,.hud { position:fixed; left:50%; transform:translateX(-50%); padding:8px 12px; border-radius:8px; background:rgba(28,28,32,.93); color:#fff; pointer-events:none; box-shadow:0 3px 14px rgba(0,0,0,.3); font:13px system-ui,sans-serif; }
      .hint { top:18px; }
      .hud { top:18px; }
      .result { position:fixed; inset:0; display:flex; flex-direction:column; background:rgba(18,18,20,.94); pointer-events:auto; font:14px system-ui,sans-serif; color:#fff; }
      .result-head { display:flex; align-items:center; gap:8px; padding:10px 14px; background:#202024; }
      .result-head strong { margin-right:auto; }
      .result-status { color:#b8f0c2; font-size:12px; white-space:nowrap; }
      .result-status.error { color:#ffb4b4; }
      .result-head button { border:0; border-radius:7px; padding:7px 12px; background:#3c3c44; color:#fff; cursor:pointer; }
      .result-head button.primary { background:#ff6b35; }
      .result-body { flex:1; min-height:0; overflow:auto; padding:18px; text-align:center; }
      .result-body img { max-width:100%; height:auto; box-shadow:0 3px 18px rgba(0,0,0,.5); background:#fff; }
      .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); padding:8px 12px; border-radius:7px; background:rgba(20,20,20,.92); color:#fff; pointer-events:none; }
      .long-origin { position:fixed; padding:5px 8px; border-radius:6px; background:rgba(255,77,79,.96); color:#fff; font:12px system-ui,sans-serif; pointer-events:none; }
      .long-help { max-width:min(560px,calc(100vw - 32px)); text-align:center; }
      .handle.s.long-grip { width:22px; height:14px; left:50%; bottom:-8px; transform:translateX(-50%); border-radius:7px; box-shadow:0 2px 7px rgba(0,0,0,.35); }
    `;
    shadow.append(style);
    document.documentElement.append(host);
    ui = { host, shadow, style };
    return ui;
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, title, onClick, extraClass = "") {
    const b = make("button", extraClass, label);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(event);
    });
    return b;
  }

  function showToast(text, ms = 1800) {
    if (!ui) return;
    const toast = make("div", "toast", text);
    ui.shadow.append(toast);
    setTimeout(() => toast.remove(), ms);
  }

  function capturePointer(event) {
    capturedPointerId = event.pointerId;
    capturedPointerOwner = ui?.stage || event.currentTarget || event.target;
    try {
      capturedPointerOwner?.setPointerCapture?.(event.pointerId);
    } catch (_) {
      capturedPointerOwner = event.target;
      try { capturedPointerOwner?.setPointerCapture?.(event.pointerId); } catch (_) {}
    }
  }

  function releasePointer(event) {
    const pointerId = capturedPointerId ?? event?.pointerId;
    try {
      if (pointerId != null && capturedPointerOwner?.hasPointerCapture?.(pointerId)) {
        capturedPointerOwner.releasePointerCapture(pointerId);
      }
    } catch (_) {}
    capturedPointerId = null;
    capturedPointerOwner = null;
  }

  function setSelection(next) {
    selection = {
      x: clamp(Math.round(next.x), 0, Math.max(0, innerWidth - MIN_SELECTION)),
      y: clamp(Math.round(next.y), 0, Math.max(0, innerHeight - MIN_SELECTION)),
      w: Math.max(MIN_SELECTION, Math.round(next.w)),
      h: Math.max(MIN_SELECTION, Math.round(next.h))
    };
    selection.w = Math.min(selection.w, innerWidth - selection.x);
    selection.h = Math.min(selection.h, innerHeight - selection.y);
    renderSelection();
  }

  function renderSelection() {
    if (!ui?.selectionEl || !selection) return;
    Object.assign(ui.selectionEl.style, {
      left: `${selection.x}px`, top: `${selection.y}px`, width: `${selection.w}px`, height: `${selection.h}px`
    });
    if (ui.sizeLabel) ui.sizeLabel.textContent = `${selection.w} × ${selection.h}`;
    positionToolbar();
    renderShapes();
  }

  function positionToolbar() {
    if (!ui?.toolbar || !selection) return;
    const toolbar = ui.toolbar;
    toolbar.style.visibility = "hidden";
    toolbar.style.left = "0px";
    toolbar.style.top = "0px";
    requestAnimationFrame(() => {
      if (!ui?.toolbar || !selection) return;
      const rect = toolbar.getBoundingClientRect();
      // WeChat-like placement: keep the toolbar attached to the selection,
      // aligned to its bottom-right edge. Only flip above when the selection
      // is literally too close to the viewport bottom to fit the toolbar.
      let left = selection.x + selection.w - rect.width;
      let top = selection.y + selection.h + 8;
      if (left + rect.width > innerWidth - 8) left = innerWidth - rect.width - 8;
      if (left < 8) left = Math.max(8, Math.min(selection.x, innerWidth - rect.width - 8));
      if (top + rect.height > innerHeight - 8) {
        const above = selection.y - rect.height - 8;
        top = above >= 8 ? above : Math.max(8, innerHeight - rect.height - 8);
      }
      left = Math.max(8, left);
      top = Math.max(8, top);
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
      toolbar.style.visibility = "visible";
    });
  }

  function updateStageCursor(p = lastPointer) {
    if (!ui?.stage) return;
    if (p) lastPointer = p;
    if (!selection) {
      ui.stage.style.cursor = "crosshair";
      return;
    }
    const isInside = p && inside(p, selection);
    if (!isInside) {
      ui.stage.style.cursor = RED_FORBIDDEN_CURSOR;
    } else if (tool === "move") {
      ui.stage.style.cursor = "move";
    } else {
      ui.stage.style.cursor = "crosshair";
    }
  }

  function buildSelectionElement() {
    const sel = make("div", "selection moving");
    const size = make("div", "size", "0 × 0");
    sel.append(size);
    for (const dir of ["nw","n","ne","e","se","s","sw","w"]) {
      const h = make("div", `handle ${dir}`);
      h.dataset.handle = dir;
      sel.append(h);
    }
    ui.shadow.append(sel);
    ui.selectionEl = sel;
    ui.sizeLabel = size;
  }

  function buildDrawLayer() {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "draw-layer");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    ui.shadow.append(svg);
    ui.svg = svg;
  }

  function shapeNode(shape) {
    let node;
    const common = { stroke: shape.color || drawColor, "stroke-width": String(shape.width || lineWidth), fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (shape.type === "rect") {
      node = document.createElementNS(NS, "rect");
      const r = normalizeRect(shape.a, shape.b);
      node.setAttribute("x", r.x); node.setAttribute("y", r.y); node.setAttribute("width", r.w); node.setAttribute("height", r.h);
    } else if (shape.type === "mosaic") {
      node = document.createElementNS(NS, "polyline");
      node.setAttribute("points", shape.points.map((p) => `${p.x},${p.y}`).join(" "));
      common.stroke = "rgba(255,255,255,.72)";
      common["stroke-width"] = String(shape.width || 24);
      common["stroke-linecap"] = "round";
      common["stroke-linejoin"] = "round";
    } else if (shape.type === "ellipse") {
      node = document.createElementNS(NS, "ellipse");
      const r = normalizeRect(shape.a, shape.b);
      node.setAttribute("cx", r.x + r.w / 2); node.setAttribute("cy", r.y + r.h / 2);
      node.setAttribute("rx", r.w / 2); node.setAttribute("ry", r.h / 2);
    } else if (shape.type === "arrow") {
      node = document.createElementNS(NS, "path");
      const { a, b } = shape;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = 12 + (shape.width || lineWidth) * 1.5;
      const p1 = { x: b.x - head * Math.cos(angle - Math.PI / 6), y: b.y - head * Math.sin(angle - Math.PI / 6) };
      const p2 = { x: b.x - head * Math.cos(angle + Math.PI / 6), y: b.y - head * Math.sin(angle + Math.PI / 6) };
      node.setAttribute("d", `M${a.x},${a.y} L${b.x},${b.y} M${p1.x},${p1.y} L${b.x},${b.y} L${p2.x},${p2.y}`);
    } else if (shape.type === "brush") {
      node = document.createElementNS(NS, "polyline");
      node.setAttribute("points", shape.points.map((p) => `${p.x},${p.y}`).join(" "));
    } else if (shape.type === "text") {
      node = document.createElementNS(NS, "text");
      node.setAttribute("x", shape.at.x); node.setAttribute("y", shape.at.y);
      node.setAttribute("fill", shape.color || drawColor);
      node.setAttribute("font-family", "system-ui,sans-serif");
      node.setAttribute("font-size", String(shape.size || 18));
      node.setAttribute("font-weight", "600");
      node.textContent = shape.text;
      delete common.stroke; delete common["stroke-width"]; delete common.fill;
    }
    if (!node) return null;
    for (const [key, value] of Object.entries(common)) node.setAttribute(key, value);
    return node;
  }

  function renderShapes() {
    if (!ui?.svg) return;
    ui.svg.replaceChildren();
    for (const shape of shapes) {
      const node = shapeNode(shape);
      if (node) ui.svg.append(node);
    }
    if (interaction?.previewShape) {
      const node = shapeNode(interaction.previewShape);
      if (node) ui.svg.append(node);
    }
  }

  function pushShape(shape) {
    shapes.push(shape);
    redoShapes = [];
    renderShapes();
  }

  function setTool(next) {
    tool = next;
    if (!ui?.toolbar) return;
    for (const b of ui.toolbar.querySelectorAll("button[data-tool]")) {
      b.classList.toggle("active", b.dataset.tool === next);
    }
    if (ui.selectionEl) ui.selectionEl.classList.toggle("moving", next === "move");
    updateStageCursor();
  }

  function buildRegionToolbar() {
    const bar = make("div", "toolbar");
    const tools = [
      ["move", "↔", "移动选区"], ["rect", "□", "矩形"], ["ellipse", "○", "椭圆"],
      ["arrow", "↗", "箭头"], ["brush", "✎", "画笔"], ["text", "T", "文字"], ["mosaic", "▦", "马赛克"]
    ];
    for (const [name, label, title] of tools) {
      const b = button(label, title, () => setTool(name));
      b.dataset.tool = name;
      bar.append(b);
    }
    bar.append(make("span", "sep"));
    const color = document.createElement("input");
    color.type = "color"; color.value = drawColor; color.title = "颜色";
    color.addEventListener("input", () => { drawColor = color.value; });
    bar.append(color);
    const width = document.createElement("select");
    for (const value of [2,3,5,8]) {
      const option = document.createElement("option");
      option.value = value; option.textContent = `${value}px`; if (value === lineWidth) option.selected = true;
      width.append(option);
    }
    width.addEventListener("change", () => { lineWidth = Number(width.value); });
    bar.append(width);
    bar.append(make("span", "sep"));
    bar.append(button("↶", "撤销", () => { if (shapes.length) { redoShapes.push(shapes.pop()); renderShapes(); } }));
    bar.append(button("↷", "重做", () => { if (redoShapes.length) { shapes.push(redoShapes.pop()); renderShapes(); } }));
    bar.append(make("span", "sep"));
    bar.append(button("复制", "复制到剪贴板", () => finalizeRegion("copy"), "wide"));
    bar.append(button("保存", "保存 PNG", () => finalizeRegion("save"), "wide"));
    bar.append(button("×", "取消", destroyUI));
    ui.shadow.append(bar);
    ui.toolbar = bar;
    setTool(tool);
    positionToolbar();
  }

  function beginResize(event, dir) {
    event.preventDefault(); event.stopPropagation();
    interaction = { type: "resize", dir, start: point(event), original: clone(selection) };
    capturePointer(event);
  }

  function resizeFrom(original, dir, p, start) {
    const dx = p.x - start.x, dy = p.y - start.y;
    let left = original.x, top = original.y, right = original.x + original.w, bottom = original.y + original.h;
    if (dir.includes("w")) left += dx;
    if (dir.includes("e")) right += dx;
    if (dir.includes("n")) top += dy;
    if (dir.includes("s")) bottom += dy;
    if (right - left < MIN_SELECTION) {
      if (dir.includes("w")) left = right - MIN_SELECTION; else right = left + MIN_SELECTION;
    }
    if (bottom - top < MIN_SELECTION) {
      if (dir.includes("n")) top = bottom - MIN_SELECTION; else bottom = top + MIN_SELECTION;
    }
    left = clamp(left, 0, innerWidth - MIN_SELECTION); top = clamp(top, 0, innerHeight - MIN_SELECTION);
    right = clamp(right, left + MIN_SELECTION, innerWidth); bottom = clamp(bottom, top + MIN_SELECTION, innerHeight);
    return { x:left, y:top, w:right-left, h:bottom-top };
  }

  function finishRegionPointer(event, cancelled = false) {
    if (!interaction) {
      releasePointer(event);
      return;
    }
    if (!cancelled && interaction.type === "shape") {
      const shape = interaction.previewShape;
      if (shape && ((shape.type === "brush" || shape.type === "mosaic")
        ? shape.points.length > 1
        : Math.hypot(shape.b.x-shape.a.x, shape.b.y-shape.a.y) > 3)) {
        shapes.push(shape);
        redoShapes = [];
      }
    }
    interaction = null;
    releasePointer(event);
    renderShapes();
    positionToolbar();
    updateStageCursor(point(event));
  }

  function startRegion() {
    shapes = []; redoShapes = []; selection = null; tool = "move";
    mountBase();
    const stage = make("div", "stage");
    const hint = make("div", "hint", "拖动鼠标框选区域；松开后可调整大小并标注");
    ui.shadow.append(stage, hint);
    ui.stage = stage; ui.hint = hint;
    buildDrawLayer();

    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const p = point(event);

      if (selection && inside(p, selection)) {
        if (tool === "move") {
          interaction = { type:"move", start:p, original:clone(selection) };
          capturePointer(event);
        } else if (tool === "text") {
          const text = window.prompt("输入文字：", "");
          if (text) pushShape({ type:"text", at:p, text, color:drawColor, size:18 });
        } else if (tool === "brush" || tool === "mosaic") {
          interaction = { type:"shape", previewShape:{
            type:tool, points:[p], color:drawColor,
            width: tool === "mosaic" ? Math.max(20, lineWidth * 6) : lineWidth
          } };
          capturePointer(event);
        } else {
          interaction = { type:"shape", previewShape:{ type:tool, a:p, b:p, color:drawColor, width:lineWidth } };
          capturePointer(event);
        }
        event.preventDefault();
        return;
      }

      shapes = []; redoShapes = [];
      interaction = { type:"select", start:p };
      if (!ui.selectionEl) buildSelectionElement();
      setSelection({ x:p.x, y:p.y, w:MIN_SELECTION, h:MIN_SELECTION });
      ui.hint.style.display = "none";
      capturePointer(event);
      event.preventDefault();
    });

    const moveInteraction = (event) => {
      if (!interaction) return;
      const p = point(event);
      if (interaction.type === "select") {
        const r = normalizeRect(interaction.start, p);
        setSelection({ x:r.x, y:r.y, w:Math.max(MIN_SELECTION,r.w), h:Math.max(MIN_SELECTION,r.h) });
      } else if (interaction.type === "move") {
        const dx = p.x - interaction.start.x, dy = p.y - interaction.start.y;
        setSelection({ ...interaction.original, x:interaction.original.x + dx, y:interaction.original.y + dy });
      } else if (interaction.type === "resize") {
        setSelection(resizeFrom(interaction.original, interaction.dir, p, interaction.start));
      } else if (interaction.type === "shape") {
        if (interaction.previewShape.type === "brush" || interaction.previewShape.type === "mosaic") interaction.previewShape.points.push(p);
        else interaction.previewShape.b = p;
        renderShapes();
      }
    };

    // Pointer move/up are handled at the shadow-root level rather than only
    // on the stage. Resize handles and the toolbar sit above the stage and
    // can otherwise receive the final pointerup, leaving a drag stuck.
    ui.shadow.addEventListener("pointermove", (event) => {
      updateStageCursor(point(event));
      moveInteraction(event);
    });
    ui.shadow.addEventListener("pointerup", (event) => {
      finishRegionPointer(event);
      queueMicrotask(() => {
        if (selection && !interaction && !ui?.toolbar) buildRegionToolbar();
      });
    });
    ui.shadow.addEventListener("pointercancel", (event) => finishRegionPointer(event, true));
    stage.addEventListener("contextmenu", (event) => event.preventDefault());

    ui.shadow.addEventListener("pointerdown", (event) => {
      const dir = event.target?.dataset?.handle;
      if (dir && selection) beginResize(event, dir);
    });
  }

  async function captureVisibleWithoutUI(scale = null) {
    if (!ui) {
      return browser.runtime.sendMessage({ type:"foxshot.captureVisible", ...(scale ? { scale } : {}) });
    }
    const previous = ui.host.style.display;
    ui.host.style.display = "none";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      return await browser.runtime.sendMessage({ type:"foxshot.captureVisible", ...(scale ? { scale } : {}) });
    } finally {
      ui.host.style.display = previous;
    }
  }


  function drawArrow(ctx, shape, scale, ox, oy) {
    const ax = (shape.a.x - ox) * scale, ay = (shape.a.y - oy) * scale;
    const bx = (shape.b.x - ox) * scale, by = (shape.b.y - oy) * scale;
    const angle = Math.atan2(by-ay, bx-ax); const head = (12 + shape.width * 1.5) * scale;
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by);
    ctx.moveTo(bx - head*Math.cos(angle-Math.PI/6), by - head*Math.sin(angle-Math.PI/6));
    ctx.lineTo(bx,by); ctx.lineTo(bx - head*Math.cos(angle+Math.PI/6), by - head*Math.sin(angle+Math.PI/6)); ctx.stroke();
  }

  function pixelateStroke(ctx, shape, scale, ox, oy, canvas) {
    if (!shape.points?.length) return;

    // Keep screenshot pixels on one canvas. Firefox has a known WebExtension
    // security bug where drawing screenshot pixels from canvas A to canvas B
    // can taint the second canvas in a content-script context.
    const radius = Math.max(1, ((shape.width || 24) * scale) / 2);
    const xs = shape.points.map((p) => (p.x - ox) * scale);
    const ys = shape.points.map((p) => (p.y - oy) * scale);
    const left = clamp(Math.floor(Math.min(...xs) - radius - 2), 0, canvas.width);
    const top = clamp(Math.floor(Math.min(...ys) - radius - 2), 0, canvas.height);
    const right = clamp(Math.ceil(Math.max(...xs) + radius + 2), 0, canvas.width);
    const bottom = clamp(Math.ceil(Math.max(...ys) + radius + 2), 0, canvas.height);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    if (!width || !height) return;

    const mask = createCanvas(width, height);
    const mctx = mask.getContext("2d");
    mctx.strokeStyle = "#fff";
    mctx.fillStyle = "#fff";
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.lineWidth = Math.max(1, (shape.width || 24) * scale);
    mctx.beginPath();
    shape.points.forEach((p, i) => {
      const x = (p.x - ox) * scale - left;
      const y = (p.y - oy) * scale - top;
      if (i) mctx.lineTo(x, y); else mctx.moveTo(x, y);
    });
    if (shape.points.length === 1) {
      const p = shape.points[0];
      mctx.arc((p.x - ox) * scale - left, (p.y - oy) * scale - top, mctx.lineWidth / 2, 0, Math.PI * 2);
      mctx.fill();
    } else {
      mctx.stroke();
    }

    const imageData = ctx.getImageData(left, top, width, height);
    const maskData = mctx.getImageData(0, 0, width, height).data;
    const pixels = imageData.data;
    const block = Math.max(6, Math.round(10 * scale));

    for (let by = 0; by < height; by += block) {
      for (let bx = 0; bx < width; bx += block) {
        const ex = Math.min(width, bx + block);
        const ey = Math.min(height, by + block);
        let touchesMask = false;
        let r = 0, g = 0, b = 0, count = 0;
        for (let y = by; y < ey; y += 1) {
          for (let x = bx; x < ex; x += 1) {
            const i = (y * width + x) * 4;
            if (maskData[i + 3]) touchesMask = true;
            r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; count += 1;
          }
        }
        if (!touchesMask || !count) continue;
        r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
        for (let y = by; y < ey; y += 1) {
          for (let x = bx; x < ex; x += 1) {
            const i = (y * width + x) * 4;
            if (!maskData[i + 3]) continue;
            pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b;
          }
        }
      }
    }
    ctx.putImageData(imageData, left, top);
  }

  function renderAnnotations(canvas, scale, ox, oy) {
    const ctx = canvas.getContext("2d");
    for (const shape of shapes.filter((s) => s.type === "mosaic")) pixelateStroke(ctx, shape, scale, ox, oy, canvas);
    for (const shape of shapes.filter((s) => s.type !== "mosaic")) {
      ctx.save(); ctx.strokeStyle = shape.color || drawColor; ctx.fillStyle = shape.color || drawColor;
      ctx.lineWidth = (shape.width || lineWidth) * scale; ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (shape.type === "rect" || shape.type === "ellipse") {
        const r = normalizeRect(shape.a,shape.b); const x=(r.x-ox)*scale, y=(r.y-oy)*scale, w=r.w*scale, h=r.h*scale;
        ctx.beginPath();
        if (shape.type === "rect") ctx.rect(x,y,w,h); else ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);
        ctx.stroke();
      } else if (shape.type === "arrow") drawArrow(ctx,shape,scale,ox,oy);
      else if (shape.type === "brush") {
        ctx.beginPath(); shape.points.forEach((p,i) => { const x=(p.x-ox)*scale,y=(p.y-oy)*scale; if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y); }); ctx.stroke();
      } else if (shape.type === "text") {
        ctx.font = `600 ${(shape.size||18)*scale}px system-ui,sans-serif`; ctx.textBaseline = "alphabetic";
        ctx.fillText(shape.text, (shape.at.x-ox)*scale, (shape.at.y-oy)*scale);
      }
      ctx.restore();
    }
  }

  async function buildRegionCanvas() {
    if (!selection) throw new Error("No selection");
    const dataUrl = await captureVisibleWithoutUI();
    const image = await loadImage(dataUrl);
    const scale = image.width / innerWidth;
    const canvas = createCanvas(selection.w*scale, selection.h*scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image,
      selection.x*scale, selection.y*scale, selection.w*scale, selection.h*scale,
      0,0,canvas.width,canvas.height
    );
    renderAnnotations(canvas, scale, selection.x, selection.y);
    return canvas;
  }

  async function copyDataUrl(dataUrl) {
    await browser.runtime.sendMessage({ type:"foxshot.copyImage", dataUrl });
  }

  async function copyCanvas(canvas) {
    await copyDataUrl(canvas.toDataURL("image/png"));
  }

  async function finalizeRegion(action) {
    try {
      const canvas = await buildRegionCanvas();
      if (action === "copy") {
        await copyCanvas(canvas);
        destroyUI();
      } else {
        await browser.runtime.sendMessage({ type:"foxshot.download", dataUrl:canvas.toDataURL("image/png"), filename:`FoxShot-region-${stamp()}.png` });
        destroyUI();
      }
    } catch (error) {
      if (ui) showToast(String(error?.message || error), 2800);
    }
  }

  function showResultDataUrl(dataUrl, title, filenameBase, autoCopy = true) {
    if (!ui) mountBase();
    releasePointer();
    ui.host.style.display = "";
    for (const child of [...ui.shadow.children]) {
      if (child !== ui.style) child.remove();
    }
    ui.selectionEl = null; ui.sizeLabel = null; ui.svg = null; ui.stage = null; ui.toolbar = null; ui.hint = null;
    const wrap = make("div", "result");
    const head = make("div", "result-head");
    const name = make("strong", "", title);
    const status = make("span", "result-status", autoCopy ? "正在复制到剪贴板…" : "");
    const copy = button("复制", "复制到剪贴板", async () => {
      try {
        status.classList.remove("error");
        status.textContent = "正在复制…";
        await copyDataUrl(dataUrl);
        status.textContent = "✓ 已复制到剪贴板";
      } catch (e) {
        status.classList.add("error");
        status.textContent = "复制失败，可点击重试";
        showToast(String(e.message||e),2800);
      }
    }, "wide");
    const save = button("保存 PNG", "保存 PNG", async () => {
      try {
        status.classList.remove("error");
        status.textContent = "正在打开保存对话框…";
        await browser.runtime.sendMessage({ type:"foxshot.download", dataUrl, filename:`${filenameBase}-${stamp()}.png` });
        status.textContent = "✓ 已交给 Firefox 保存";
      } catch (error) {
        status.classList.add("error");
        status.textContent = "保存失败";
        showToast(`保存失败：${String(error?.message || error)}`, 4200);
      }
    }, "wide primary");
    const close = button("×", "关闭", destroyUI);
    head.append(name, status, copy, save, close);
    const body = make("div", "result-body");
    const image = document.createElement("img"); image.alt = title; image.src = dataUrl;
    body.append(image); wrap.append(head, body); ui.shadow.append(wrap);

    if (autoCopy) {
      Promise.resolve().then(async () => {
        try {
          await copyDataUrl(dataUrl);
          if (ui?.host?.isConnected) status.textContent = "✓ 已复制到剪贴板";
        } catch (error) {
          if (!ui?.host?.isConnected) return;
          status.classList.add("error");
          status.textContent = "自动复制失败，可点击重试";
          console.warn("FoxShot automatic clipboard copy failed", error);
        }
      });
    }
  }

  function showResult(canvas, title, filenameBase, autoCopy = true) {
    showResultDataUrl(canvas.toDataURL("image/png"), title, filenameBase, autoCopy);
  }

  function elementUnderUI(x, y) {
    const host = ui?.host;
    const previous = host?.style.display;
    if (host) host.style.display = "none";
    let element = null;
    try { element = document.elementFromPoint(clamp(x, 0, innerWidth - 1), clamp(y, 0, innerHeight - 1)); }
    finally { if (host) host.style.display = previous; }
    return element;
  }

  function isScrollableElement(element) {
    if (!element || element === document.body || element === document.documentElement) return false;
    if (element.scrollHeight <= element.clientHeight + 4) return false;
    const style = getComputedStyle(element);
    return /(auto|scroll|overlay)/.test(style.overflowY);
  }

  function findScrollerAt(x, y) {
    let element = elementUnderUI(x, y);
    while (element && element !== document.body && element !== document.documentElement) {
      if (isScrollableElement(element)) return makeScroller(element);
      element = element.parentElement;
    }
    return makeScroller(null);
  }

  function makeScroller(element) {
    const root = !element;
    const scrollingElement = document.scrollingElement || document.documentElement;
    return {
      root,
      element: root ? scrollingElement : element,
      eventTarget: root ? window : element,
      getTop: () => root ? window.scrollY : element.scrollTop,
      setTop: (top) => { if (root) window.scrollTo(window.scrollX, top); else element.scrollTop = top; },
      getTotalHeight: () => root
        ? Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
        : element.scrollHeight,
      getViewportHeight: () => root ? innerHeight : element.clientHeight,
      getRect: () => {
        if (root) return { x:0, y:0, w:innerWidth, h:innerHeight, top:0, left:0, right:innerWidth, bottom:innerHeight };
        const r = element.getBoundingClientRect();
        const rawLeft = r.left + (element.clientLeft || 0);
        const rawTop = r.top + (element.clientTop || 0);
        const rawRight = rawLeft + element.clientWidth;
        const rawBottom = rawTop + element.clientHeight;
        const left = clamp(rawLeft, 0, innerWidth), top = clamp(rawTop, 0, innerHeight);
        const right = clamp(rawRight, 0, innerWidth), bottom = clamp(rawBottom, 0, innerHeight);
        return { x:left, y:top, w:Math.max(1,right-left), h:Math.max(1,bottom-top), top, left, right, bottom };
      }
    };
  }

  async function settleScroller(scroller, top) {
    const element = scroller.element;
    const oldBehavior = element.style.scrollBehavior;
    element.style.scrollBehavior = "auto";
    scroller.setTop(top);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await sleep(180);
    element.style.scrollBehavior = oldBehavior;
    return scroller.getTop();
  }

  function fixedElements() {
    const result = [];
    const seen = new Set();
    const xs = [8, innerWidth * 0.25, innerWidth * 0.5, innerWidth * 0.75, Math.max(8, innerWidth - 8)];
    const ys = [8, 40, 96, innerHeight * 0.5, Math.max(8, innerHeight - 8)];

    for (const x of xs) {
      for (const y of ys) {
        for (const leaf of document.elementsFromPoint(clamp(x, 0, innerWidth - 1), clamp(y, 0, innerHeight - 1))) {
          let element = leaf;
          while (element && element !== document.documentElement && element !== document.body) {
            if (element === ui?.host || element?.dataset?.foxshotUi === "true") break;
            if (!seen.has(element)) {
              seen.add(element);
              const position = getComputedStyle(element).position;
              if (position === "fixed" || position === "sticky") {
                result.push([element, element.style.visibility]);
                break;
              }
            }
            element = element.parentElement;
          }
        }
      }
    }
    return result;
  }

  function setFixedVisibility(entries, hidden) {
    for (const [element, old] of entries) element.style.visibility = hidden ? "hidden" : old;
  }


  function rootPageRect() {
    const de = document.documentElement;
    const body = document.body;
    const width = Math.max(
      de?.scrollWidth || 0, de?.clientWidth || 0,
      body?.scrollWidth || 0, body?.clientWidth || 0,
      innerWidth
    );
    const height = Math.max(
      de?.scrollHeight || 0, de?.clientHeight || 0,
      body?.scrollHeight || 0, body?.clientHeight || 0,
      innerHeight
    );
    return { x: 0, y: 0, width, height };
  }

  function rootIsScrollable() {
    const rect = rootPageRect();
    return rect.height > innerHeight + 4;
  }

  async function captureScrollerRange(scroller, options) {
    const start = Math.max(0, Number(options.start) || 0);
    let end = Math.max(start + 1, Number(options.end) || start + 1);
    const screenX = Math.max(0, Number(options.screenX) || 0);
    const width = Math.max(1, Number(options.width) || 1);
    const status = options.status || null;
    const hideFixedAfterFirst = options.hideFixedAfterFirst === true && scroller.root;
    const frames = [];
    let cursor = start;
    let scale = null;
    let iterations = 0;
    let fixedEntries = [];
    let fixedHidden = false;

    try {
      while (cursor < end - 0.5) {
        if (++iterations > 160) throw new Error("截图段数过多，请缩短范围后重试");
        const totalHeight = scroller.getTotalHeight();
        end = Math.min(end, totalHeight);
        const viewportHeight = scroller.getViewportHeight();
        const maxScroll = Math.max(0, totalHeight - viewportHeight);
        const targetTop = Math.min(cursor, maxScroll);
        const actualTop = await settleScroller(scroller, targetTop);
        const viewportRect = scroller.getRect();
        const contentOffset = Math.max(0, cursor - actualTop);
        const visibleAvailable = Math.max(0, viewportRect.h - contentOffset);
        const cssHeight = Math.min(visibleAvailable, end - cursor);
        if (cssHeight <= 0.5) throw new Error("滚动区域无法继续捕获");

        if (status) {
          const pct = Math.min(100, Math.round(((cursor - start + cssHeight) / Math.max(1, end - start)) * 100));
          status.textContent = `正在生成截图… ${pct}%`;
        }

        const dataUrl = await captureVisibleWithoutUI(1);
        const image = await loadImage(dataUrl);
        if (scale == null) scale = image.width / innerWidth;
        const cropX = clamp(screenX, 0, Math.max(0, innerWidth - 1));
        const cropWidth = Math.min(width, innerWidth - cropX);
        const cropY = clamp(viewportRect.top + contentOffset, 0, Math.max(0, innerHeight - 1));
        const cropHeight = Math.min(cssHeight, innerHeight - cropY);
        if (cropWidth <= 0 || cropHeight <= 0) throw new Error("选区超出可捕获区域");

        // Store the original screenshot plus crop metadata. We deliberately do
        // NOT create per-segment canvases and then draw canvas->canvas: Firefox
        // can incorrectly taint that second canvas in a WebExtension content
        // script. Final composition draws every screenshot image directly.
        frames.push({
          dataUrl,
          cropX,
          cropY,
          cropWidth,
          cropHeight,
          outY: cursor - start
        });

        if (hideFixedAfterFirst && !fixedHidden) {
          fixedEntries = fixedElements();
          if (fixedEntries.length) {
            setFixedVisibility(fixedEntries, true);
            fixedHidden = true;
          }
        }

        cursor += cropHeight;
      }

      if (!frames.length || scale == null) throw new Error("没有捕获到图像");
      const usedHeight = Math.max(...frames.map((frame) => frame.outY + frame.cropHeight));
      const outputWidth = Math.max(1, Math.round(frames[0].cropWidth * scale));
      const outputHeight = Math.max(1, Math.round(usedHeight * scale));
      if (outputHeight > MAX_OUTPUT_HEIGHT || outputWidth > 32000) {
        throw new Error("截图超过单张图片安全尺寸，请缩短范围后重试");
      }

      const out = createCanvas(outputWidth, outputHeight);
      const ctx = out.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      for (const frame of frames) {
        const image = await loadImage(frame.dataUrl);
        ctx.drawImage(
          image,
          frame.cropX * scale,
          frame.cropY * scale,
          frame.cropWidth * scale,
          frame.cropHeight * scale,
          0,
          frame.outY * scale,
          frame.cropWidth * scale,
          frame.cropHeight * scale
        );
      }
      return out.toDataURL("image/png");
    } finally {
      if (fixedHidden) setFixedVisibility(fixedEntries, false);
    }
  }

  async function startFullPage() {
    mountBase();
    const hud = make("div", "hud", "正在分析页面…");
    ui.shadow.append(hud);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const originX = scrollX;
    const originY = scrollY;
    let scroller = null;
    let originTop = 0;
    try {
      if (rootIsScrollable()) {
        scroller = makeScroller(null);
      } else {
        scroller = findScrollerAt(innerWidth / 2, innerHeight / 2);
      }

      if (scroller.root) {
        originTop = scroller.getTop();
        const totalHeight = scroller.getTotalHeight();
        if (totalHeight > MAX_OUTPUT_HEIGHT) {
          throw new Error("页面超过单张图片安全高度，请使用长截图选择需要的部分");
        }
        hud.textContent = totalHeight > innerHeight + 4
          ? "正在按固定步长捕获整页…"
          : "正在捕获当前页面…";
        const dataUrl = await captureScrollerRange(scroller, {
          start: 0,
          end: totalHeight,
          screenX: 0,
          width: innerWidth,
          status: hud,
          hideFixedAfterFirst: true
        });
        await settleScroller(scroller, originTop).catch(() => {});
        window.scrollTo(originX, originY);
        hud.textContent = "整页截图完成，正在复制…";
        showResultDataUrl(dataUrl, "整页截图", "FoxShot-full", true);
        return;
      }

      if (scroller.getTotalHeight() <= scroller.getViewportHeight() + 4) {
        // Nothing scrolls: capture the visible page once through the same safe
        // pipeline rather than using Firefox's off-screen rect path.
        scroller = makeScroller(null);
        originTop = scroller.getTop();
        const dataUrl = await captureScrollerRange(scroller, {
          start: originTop,
          end: originTop + innerHeight,
          screenX: 0,
          width: innerWidth,
          status: hud
        });
        showResultDataUrl(dataUrl, "整页截图", "FoxShot-full", true);
        return;
      }

      originTop = scroller.getTop();
      const rect = scroller.getRect();
      if (scroller.getTotalHeight() > MAX_OUTPUT_HEIGHT) {
        throw new Error("滚动区域超过单张图片安全高度，请使用长截图选择需要的部分");
      }
      hud.textContent = "检测到页面内部滚动区域，正在按固定步长捕获…";
      const dataUrl = await captureScrollerRange(scroller, {
        start: 0,
        end: scroller.getTotalHeight(),
        screenX: rect.left,
        width: rect.w,
        status: hud
      });
      await settleScroller(scroller, originTop).catch(() => {});
      hud.textContent = "整页截图完成，正在复制…";
      showResultDataUrl(dataUrl, "整页截图", "FoxShot-full", true);
    } catch (error) {
      if (scroller) await settleScroller(scroller, originTop).catch(() => {});
      window.scrollTo(originX, originY);
      if (ui) {
        hud.textContent = `整页截图失败：${String(error?.message || error)}`;
        setTimeout(destroyUI, 9000);
      }
      console.error("FoxShot full-page capture failed", error);
    }
  }

  function longContentYFromScreen(session, screenY) {
    const rect = session.scroller.getRect();
    const y = clamp(screenY, rect.top, rect.bottom);
    return clamp(
      session.scroller.getTop() + (y - rect.top),
      0,
      session.scroller.getTotalHeight()
    );
  }

  function longScreenYFromContent(session, contentY) {
    const rect = session.scroller.getRect();
    return rect.top + contentY - session.scroller.getTop();
  }

  function positionLongToolbar() {
    if (!longSession || !ui?.toolbar) return;
    positionToolbar();
  }

  function renderLongRange() {
    const s = longSession;
    if (!s || !ui?.selectionEl) return;
    const rect = s.scroller.getRect();
    const topScreen = longScreenYFromContent(s, s.startContentY);
    const bottomScreen = longScreenYFromContent(s, s.endContentY);
    const visibleTop = clamp(topScreen, rect.top, rect.bottom);
    const visibleBottom = clamp(bottomScreen, rect.top, rect.bottom);
    const visibleHeight = Math.max(1, visibleBottom - visibleTop);

    selection = { x: s.screenX, y: visibleTop, w: s.width, h: visibleHeight };
    Object.assign(ui.selectionEl.style, {
      left: `${s.screenX}px`,
      top: `${visibleTop}px`,
      width: `${s.width}px`,
      height: `${visibleHeight}px`,
      borderTopColor: topScreen < rect.top - 0.5 ? "transparent" : "#ff4d4f",
      borderBottomColor: bottomScreen > rect.bottom + 0.5 ? "transparent" : "#ff4d4f"
    });
    if (ui.sizeLabel) {
      ui.sizeLabel.textContent = `${Math.round(s.width)} × ${Math.round(s.endContentY - s.startContentY)}`;
      ui.sizeLabel.style.display = topScreen >= rect.top - 1 ? "block" : "none";
    }

    for (const handle of ui.selectionEl.querySelectorAll(".handle")) {
      const show = handle.dataset.handle === "s" && bottomScreen >= rect.top && bottomScreen <= rect.bottom;
      handle.style.display = show ? "block" : "none";
      if (show) handle.classList.add("long-grip");
    }

    if (s.originBadge) {
      if (topScreen < rect.top) {
        s.originBadge.style.display = "block";
        s.originBadge.style.left = `${clamp(s.screenX + 6, 8, Math.max(8, innerWidth - 130))}px`;
        s.originBadge.style.top = `${clamp(rect.top + 8, 8, innerHeight - 34)}px`;
      } else {
        s.originBadge.style.display = "none";
      }
    }
    if (s.status && !s.capturing) {
      s.status.textContent = `范围高度 ${Math.round(s.endContentY - s.startContentY)} px · 拖住下边缘继续向下`;
    }
    positionLongToolbar();
  }

  function updateLongEndFromPointer() {
    const s = longSession;
    if (!s?.extending || !s.pointer) return;
    const next = longContentYFromScreen(s, s.pointer.y);
    s.endContentY = clamp(Math.max(s.startContentY + MIN_SELECTION, next), s.startContentY + MIN_SELECTION, s.scroller.getTotalHeight());
    renderLongRange();
  }

  function stopLongAutoScroll() {
    if (longSession?.autoScrollRaf) cancelAnimationFrame(longSession.autoScrollRaf);
    if (longSession) longSession.autoScrollRaf = null;
  }

  function runLongAutoScroll() {
    stopLongAutoScroll();
    const tick = () => {
      const s = longSession;
      if (!s?.extending || !s.pointer) return;
      const rect = s.scroller.getRect();
      const threshold = Math.max(44, Math.min(88, rect.h * 0.18));
      const distanceIntoEdge = s.pointer.y - (rect.bottom - threshold);
      if (distanceIntoEdge > 0) {
        const maxScroll = Math.max(0, s.scroller.getTotalHeight() - s.scroller.getViewportHeight());
        const before = s.scroller.getTop();
        const strength = clamp(distanceIntoEdge / threshold, 0, 1.4);
        const delta = Math.max(4, Math.round(5 + 26 * strength));
        s.scroller.setTop(Math.min(maxScroll, before + delta));
        if (s.scroller.getTop() > before + 0.1) updateLongEndFromPointer();
      }
      s.autoScrollRaf = requestAnimationFrame(tick);
    };
    longSession.autoScrollRaf = requestAnimationFrame(tick);
  }

  function beginLongExtend(event) {
    const s = longSession;
    if (!s || s.capturing || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    s.extending = true;
    s.pointer = point(event);
    interaction = { type: "long-extend" };
    capturePointer(event);
    updateLongEndFromPointer();
    runLongAutoScroll();
  }

  function finishLongExtend(event) {
    const s = longSession;
    if (!s?.extending) return;
    s.pointer = point(event);
    updateLongEndFromPointer();
    s.extending = false;
    interaction = null;
    stopLongAutoScroll();
    releasePointer(event);
    renderLongRange();
  }

  async function cancelLongRange() {
    const s = longSession;
    if (!s) { destroyUI(); return; }
    stopLongAutoScroll();
    s.scroller.eventTarget.removeEventListener("scroll", s.onScroll, true);
    await settleScroller(s.scroller, s.originTop).catch(() => {});
    if (s.scroller.root) window.scrollTo(s.originWindowX, s.originWindowY);
    longSession = null;
    destroyUI();
  }

  async function completeLongRange() {
    const s = longSession;
    if (!s || s.capturing) return;
    s.capturing = true;
    stopLongAutoScroll();
    s.scroller.eventTarget.removeEventListener("scroll", s.onScroll, true);
    const rangeHeight = Math.max(1, s.endContentY - s.startContentY);
    try {
      if (rangeHeight > MAX_OUTPUT_HEIGHT) {
        throw new Error("选择范围超过单张长图安全高度，请缩短范围");
      }
      if (s.status) s.status.textContent = "正在按选定范围生成长图…";

      // The user's drag defines only the start/end range. Actual capture is a
      // deterministic fixed-step pass, so mouse-wheel distance and drag speed
      // cannot create gaps or overlaps.
      const dataUrl = await captureScrollerRange(s.scroller, {
        start: s.startContentY,
        end: s.endContentY,
        screenX: s.screenX,
        width: s.width,
        status: s.status,
        hideFixedAfterFirst: true
      });

      await settleScroller(s.scroller, s.originTop).catch(() => {});
      if (s.scroller.root) window.scrollTo(s.originWindowX, s.originWindowY);
      longSession = null;
      showResultDataUrl(dataUrl, "长截图", "FoxShot-long", true);
    } catch (error) {
      await settleScroller(s.scroller, s.originTop).catch(() => {});
      if (s.scroller.root) window.scrollTo(s.originWindowX, s.originWindowY);
      s.capturing = false;
      s.scroller.eventTarget.addEventListener("scroll", s.onScroll, true);
      renderLongRange();
      if (s.status) s.status.textContent = `长截图失败：${String(error?.message || error)}`;
      console.error("FoxShot long capture failed", error);
    }
  }

  function buildLongToolbar() {
    const s = longSession;
    const bar = make("div", "toolbar");
    const status = make("span", "", "拖住下边缘向下延伸；接近底部会自动滚动");
    status.style.padding = "0 7px";
    const complete = button("完成", "按当前范围生成长截图", completeLongRange, "wide");
    const reselect = button("重选", "重新选择长截图范围", () => startLong(), "wide");
    const cancel = button("取消", "取消长截图", cancelLongRange, "wide");
    bar.append(status, complete, reselect, cancel);
    ui.shadow.append(bar);
    ui.toolbar = bar;
    s.status = status;
    positionLongToolbar();
  }

  function prepareLongRange() {
    if (!selection || longSession) return;
    const centerX = selection.x + selection.w / 2;
    const centerY = selection.y + selection.h / 2;
    let scroller = findScrollerAt(centerX, centerY);
    if (!scroller.root && scroller.getTotalHeight() <= scroller.getViewportHeight() + 4) scroller = makeScroller(null);
    const rect = scroller.getRect();
    const screenX = clamp(selection.x, rect.left, Math.max(rect.left, rect.right - MIN_SELECTION));
    const right = clamp(selection.x + selection.w, screenX + MIN_SELECTION, rect.right);
    const width = Math.max(MIN_SELECTION, right - screenX);
    const startScreenY = clamp(selection.y, rect.top, Math.max(rect.top, rect.bottom - MIN_SELECTION));
    const endScreenY = clamp(selection.y + selection.h, startScreenY + MIN_SELECTION, rect.bottom);
    const originTop = scroller.getTop();
    const startContentY = clamp(originTop + (startScreenY - rect.top), 0, scroller.getTotalHeight());
    const endContentY = clamp(originTop + (endScreenY - rect.top), startContentY + MIN_SELECTION, scroller.getTotalHeight());

    const originBadge = make("div", "long-origin", "↑ 起点已锁定");
    originBadge.style.display = "none";
    ui.shadow.append(originBadge);

    longSession = {
      scroller,
      screenX,
      width,
      documentX: scroller.root ? scrollX + screenX : screenX,
      startContentY,
      endContentY,
      originTop,
      originWindowX: scrollX,
      originWindowY: scrollY,
      originBadge,
      status: null,
      extending: false,
      pointer: null,
      autoScrollRaf: null,
      capturing: false,
      onScroll: null
    };
    longSession.onScroll = () => {
      if (!longSession || longSession.capturing) return;
      if (longSession.extending) updateLongEndFromPointer();
      else renderLongRange();
    };
    scroller.eventTarget.addEventListener("scroll", longSession.onScroll, true);
    if (ui.hint) {
      ui.hint.classList.add("long-help");
      ui.hint.style.display = "block";
      ui.hint.textContent = "拖住选框下边缘向下拉；到滚动区域底部附近时页面会自动向下滚。松手后可继续拖，截到想要的位置再点“完成”。";
    }
    buildLongToolbar();
    renderLongRange();
  }

  function finishLongInitialSelection(event) {
    if (!interaction) {
      releasePointer(event);
      return;
    }
    interaction = null;
    releasePointer(event);
    if (selection) prepareLongRange();
  }

  function startLong() {
    if (longSession) {
      const previous = longSession;
      stopLongAutoScroll();
      previous.scroller.eventTarget.removeEventListener("scroll", previous.onScroll, true);
      settleScroller(previous.scroller, previous.originTop).catch(() => {});
      if (previous.scroller.root) window.scrollTo(previous.originWindowX, previous.originWindowY);
      longSession = null;
    }
    selection = null; shapes = []; redoShapes = []; interaction = null;
    mountBase();
    const stage = make("div", "stage");
    const hint = make("div", "hint", "先框选长截图的宽度和起点；松开后拖住下边缘继续向下延伸");
    ui.shadow.append(stage, hint); ui.stage = stage; ui.hint = hint;

    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || longSession) return;
      const p = point(event);
      interaction = { type:"select", start:p };
      if (!ui.selectionEl) buildSelectionElement();
      setSelection({ x:p.x, y:p.y, w:MIN_SELECTION, h:MIN_SELECTION });
      ui.hint.style.display = "none";
      capturePointer(event);
      event.preventDefault();
    });

    ui.shadow.addEventListener("pointerdown", (event) => {
      if (longSession && event.target?.dataset?.handle === "s") beginLongExtend(event);
    });

    ui.shadow.addEventListener("pointermove", (event) => {
      if (longSession?.extending) {
        longSession.pointer = point(event);
        updateLongEndFromPointer();
        return;
      }
      if (!interaction || longSession) return;
      const p = point(event);
      if (interaction.type === "select") {
        const r = normalizeRect(interaction.start, p);
        setSelection({ x:r.x, y:r.y, w:Math.max(MIN_SELECTION,r.w), h:Math.max(MIN_SELECTION,r.h) });
      }
    });

    ui.shadow.addEventListener("pointerup", (event) => {
      if (longSession?.extending) finishLongExtend(event);
      else if (!longSession) finishLongInitialSelection(event);
    });
    ui.shadow.addEventListener("pointercancel", (event) => {
      if (longSession?.extending) finishLongExtend(event);
      else if (!longSession) finishLongInitialSelection(event);
    });
    stage.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "foxshot.ping") return Promise.resolve({ok:true});
    if (message?.type === "foxshot.start") {
      if (message.mode === "region") startRegion();
      else if (message.mode === "full") startFullPage();
      else if (message.mode === "long") startLong();
      return Promise.resolve({ok:true});
    }
    return undefined;
  });

  window.addEventListener("keydown", (event) => {
    if (!ui) return;
    if (event.key === "Escape") {
      if (longSession) cancelLongRange().catch(() => destroyUI());
      else destroyUI();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey && shapes.length) {
      redoShapes.push(shapes.pop()); renderShapes(); event.preventDefault();
    }
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z")) && redoShapes.length) {
      shapes.push(redoShapes.pop()); renderShapes(); event.preventDefault();
    }
  }, true);
})();
