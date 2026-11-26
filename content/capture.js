/* SPDX-License-Identifier: MIT */
"use strict";

(() => {
  if (window.__foxshotLoaded) return;
  window.__foxshotLoaded = true;

  // Content-script overlays need explicit localization; popup localization is separate.
  function t(key, fallback, ...args) {
    const values = args.map(String);
    const substitutions = values.length === 1 ? values[0] : values;
    const message = browser.i18n?.getMessage?.(key, substitutions) || fallback;
    return message.replace(/\$([1-9])/g, (_, index) => values[Number(index) - 1] ?? "");
  }

  const MAX_OUTPUT_HEIGHT = 32000;
  const MIN_SELECTION = 12;
  const NS = "http://www.w3.org/2000/svg";
  const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const COLOR_PALETTE = ["#ff3b30", "#f97316", "#facc15", "#10b981", "#3b82f6", "#1e293b", "#ffffff"];
  const STROKE_PRESETS = [
    { value: 2, dot: 5, key: "capSizeSmall", fallback: "细" },
    { value: 4, dot: 8, key: "capSizeMedium", fallback: "中" },
    { value: 7, dot: 12, key: "capSizeLarge", fallback: "粗" }
  ];
  const MOSAIC_PRESETS = [
    { value: 18, dot: 6, key: "capSizeSmall", fallback: "细" },
    { value: 28, dot: 9, key: "capSizeMedium", fallback: "中" },
    { value: 42, dot: 13, key: "capSizeLarge", fallback: "粗" }
  ];
  const TEXT_PRESETS = [
    { value: 15, key: "capTextSmall", fallback: "小" },
    { value: 20, key: "capTextMedium", fallback: "中" },
    { value: 28, key: "capTextLarge", fallback: "大" }
  ];
  const RED_FORBIDDEN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="10" fill="white" fill-opacity=".92" stroke="#f97316" stroke-width="2.8"/><path d="M7 21 21 7" stroke="#f97316" stroke-width="2.8" stroke-linecap="round"/></svg>'
  )}") 14 14, not-allowed`;

  let ui = null;
  let selection = null;
  let shapes = [];
  let redoShapes = [];
  let tool = "move";
  let drawColor = "#ff3b30";
  let lineWidth = 4;
  let mosaicWidth = 28;
  let textSize = 20;
  let themePreference = "system";
  let activeTextEditor = null;
  let interaction = null;
  let longSession = null;
  let capturedPointerId = null;
  let capturedPointerOwner = null;
  let lastPointer = null;
  let resultScrollLock = null;
  let resultEditor = null;
  let currentCapture = null;

  function normalizeTheme(value) {
    return value === "light" || value === "dark" ? value : "system";
  }

  function applyThemeToHost(host, pref = themePreference) {
    if (!host?.dataset) return;
    const normalized = normalizeTheme(pref);
    if (normalized === "light" || normalized === "dark") host.dataset.theme = normalized;
    else delete host.dataset.theme;
  }

  async function syncThemePreference() {
    try {
      const settings = await browser.storage?.local?.get?.({ uiTheme: "system" });
      if (settings && "uiTheme" in settings) {
        themePreference = normalizeTheme(settings.uiTheme);
        if (ui?.host) applyThemeToHost(ui.host, themePreference);
      }
    } catch (_) {
      // Keep default system theme if storage is unavailable.
    }
  }
  void syncThemePreference();
  browser.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === "local" && changes.uiTheme) {
      themePreference = normalizeTheme(changes.uiTheme.newValue);
      if (ui?.host) applyThemeToHost(ui.host, themePreference);
    }
  });

  function cancelCurrentCapture() {
    if (currentCapture) currentCapture.cancelled = true;
  }
  function captureWasCancelled(task) {
    return Boolean(task && (task.cancelled || currentCapture !== task));
  }
  function assertCaptureRunning(task) {
    if (captureWasCancelled(task)) throw new Error("FoxShot capture cancelled");
  }

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

  function rememberInlineProperty(element, name) {
    if (!element) return null;
    return {
      value: element.style.getPropertyValue(name),
      priority: element.style.getPropertyPriority(name)
    };
  }

  function restoreInlineProperty(element, name, saved) {
    if (!element || !saved) return;
    element.style.removeProperty(name);
    if (saved.value) element.style.setProperty(name, saved.value, saved.priority);
  }

  function lockResultPageScroll() {
    if (resultScrollLock) return;
    const root = document.documentElement;
    const body = document.body;
    resultScrollLock = {
      x: window.scrollX,
      y: window.scrollY,
      root,
      body,
      rootOverflow: rememberInlineProperty(root, "overflow"),
      bodyOverflow: rememberInlineProperty(body, "overflow")
    };
    root.style.setProperty("overflow", "hidden", "important");
    if (body) body.style.setProperty("overflow", "hidden", "important");
  }

  function unlockResultPageScroll() {
    if (!resultScrollLock) return;
    const saved = resultScrollLock;
    resultScrollLock = null;
    restoreInlineProperty(saved.root, "overflow", saved.rootOverflow);
    restoreInlineProperty(saved.body, "overflow", saved.bodyOverflow);
    requestAnimationFrame(() => window.scrollTo(saved.x, saved.y));
  }

  function cancelActiveTextEditor() {
    if (!activeTextEditor) return;
    const editor = activeTextEditor;
    activeTextEditor = null;
    editor.cleanup();
  }

  function commitActiveTextEditor() {
    if (!activeTextEditor) return false;
    const editor = activeTextEditor;
    activeTextEditor = null;
    return editor.commit();
  }

  function destroyUI() {
    if (ui?.mosaicTimer) clearTimeout(ui.mosaicTimer);
    cancelActiveTextEditor();
    cancelCurrentCapture();
    releasePointer();
    unlockResultPageScroll();
    if (longSession) {
      const session = longSession;
      stopLongAutoScroll();
      try { session.scroller.eventTarget.removeEventListener("scroll", session.onScroll, true); } catch (_) {}
      try { session.scroller.setTop(session.originTop); } catch (_) {}
      if (session.scroller.root) {
        try { window.scrollTo(session.originWindowX, session.originWindowY); } catch (_) {}
      }
      if (session.scrollControls) restoreCaptureScrollControls(session.scrollControls);
      longSession = null;
    }
    if (ui?.modalShell?.open) ui.modalShell.close();
    if (ui?.popoverHost?.matches(":popover-open")) ui.popoverHost.hidePopover();
    if (ui?.modalShell?.isConnected) ui.modalShell.remove();
    else if (ui?.host?.isConnected) ui.host.remove();
    ui?.backdropStyle?.remove();
    ui = null;
    interaction = null;
    resultEditor = null;
  }

  // Native modal dialogs and popovers live in the browser top layer.
  // A regular z-index overlay cannot cover them.
  function findForegroundSurface() {
    const surfaces = [];
    function scan(root) {
      for (const node of root.querySelectorAll("*")) {
        if (node === ui?.host) continue;
        if (node.matches?.('dialog:modal, :popover-open, [role="dialog"][aria-modal="true"], [aria-modal="true"]')) {
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden") surfaces.push(node);
        }
        if (node.shadowRoot) scan(node.shadowRoot);
      }
    }
    scan(document);
    // A native modal must stay above other top-layer elements created later.
    return surfaces.filter((node) => node.matches("dialog:modal")).at(-1)
      || surfaces.filter((node) => node.matches(":popover-open")).at(-1)
      || surfaces.at(-1) || null;
  }

  function hideCaptureUIForProbe(callback) {
    const shown = ui;
    if (!shown) return callback();
    const previous = shown.host.style.display;
    if (shown.modalShell?.open) shown.modalShell.close();
    if (shown.popoverHost?.matches(":popover-open")) shown.popoverHost.hidePopover();
    shown.host.style.display = "none";
    try {
      return callback();
    } finally {
      if (ui === shown && shown.host.isConnected) {
        shown.host.style.display = previous;
        if (shown.modalShell && !shown.modalShell.open) shown.modalShell.showModal();
        else if (shown.popoverHost && !shown.popoverHost.matches(":popover-open")) shown.popoverHost.showPopover();
      }
    }
  }

  function mountBase() {
    destroyUI();
    const foreground = findForegroundSurface();
    const topLayer = Boolean(foreground?.matches("dialog:modal, :popover-open"));
    const modalTopLayer = Boolean(foreground?.matches("dialog:modal"));
    const host = document.createElement("div");
    host.dataset.foxshotUi = "true";
    applyThemeToHost(host, themePreference);
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const popoverHost = topLayer && !modalTopLayer ? host : null;
    if (popoverHost) {
      // Manual popovers do not dismiss an existing auto popover.
      host.popover = "manual";
      host.style.cssText += "margin:0;padding:0;border:0;width:100vw;height:100vh;max-width:none;max-height:none;overflow:visible;background:transparent;";
    }
    // dialog itself cannot attach a shadow root in current browsers; keep
    // the extension UI in a shadow-host div inside a transparent modal shell.
    let modalShell = null;
    let backdropStyle = null;
    if (modalTopLayer) {
      modalShell = document.createElement("dialog");
      modalShell.dataset.foxshotUiShell = "true";
      modalShell.style.cssText = "position:fixed;inset:0;margin:0;padding:0;border:0;width:100vw;height:100vh;max-width:none;max-height:none;overflow:visible;background:transparent;pointer-events:none;";
      backdropStyle = document.createElement("style");
      backdropStyle.textContent = 'dialog[data-foxshot-ui-shell="true"]::backdrop { background:transparent!important;backdrop-filter:none!important; }';
      document.documentElement.append(backdropStyle);
    }
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        color-scheme: light dark;
        --fx-accent: #f97316;
        --fx-accent-hover: #ea580c;
        --fx-accent-ink: #ea580c;
        --fx-accent-soft: rgba(249, 115, 22, 0.13);
        --fx-accent-ring: rgba(249, 115, 22, 0.34);
        --fx-bar-bg: rgba(255, 255, 255, 0.90);
        --fx-bar-solid: #ffffff;
        --fx-bar-border: rgba(15, 23, 42, 0.10);
        --fx-bar-shadow: 0 12px 30px -6px rgba(15, 23, 42, 0.22), 0 2px 6px rgba(15, 23, 42, 0.08);
        --fx-text: #1e293b;
        --fx-muted: #64748b;
        --fx-hover: rgba(15, 23, 42, 0.07);
        --fx-sep: rgba(15, 23, 42, 0.11);
        --fx-danger: #ef4444;
        --fx-danger-soft: rgba(239, 68, 68, 0.11);
        --fx-pill-bg: rgba(15, 23, 42, 0.80);
        --fx-pill-text: #f8fafc;
        --fx-pill-border: rgba(255, 255, 255, 0.14);
        --fx-result-bg: #eef2f6;
        --fx-result-head-bg: rgba(255, 255, 255, 0.90);
        --fx-result-btn-bg: rgba(15, 23, 42, 0.06);
        --fx-result-btn-hover: rgba(15, 23, 42, 0.11);
        --fx-ok-bg: rgba(16, 185, 129, 0.12);
        --fx-ok-text: #059669;
        --fx-err-bg: rgba(239, 68, 68, 0.12);
        --fx-err-text: #dc2626;
        --fx-swatch-light-border: rgba(15, 23, 42, 0.22);
        --fx-swatch-dark-border: transparent;
      }
      :host([data-theme="light"]) { color-scheme: light; }
      @media (prefers-color-scheme: dark) {
        :host(:not([data-theme="light"])) {
          --fx-accent: #fb923c;
          --fx-accent-hover: #f97316;
          --fx-accent-ink: #fb923c;
          --fx-accent-soft: rgba(251, 146, 60, 0.20);
          --fx-accent-ring: rgba(251, 146, 60, 0.44);
          --fx-bar-bg: rgba(28, 29, 36, 0.88);
          --fx-bar-solid: #21222a;
          --fx-bar-border: rgba(255, 255, 255, 0.12);
          --fx-bar-shadow: 0 14px 34px -6px rgba(0, 0, 0, 0.56), 0 2px 8px rgba(0, 0, 0, 0.30);
          --fx-text: #f1f5f9;
          --fx-muted: #94a3b8;
          --fx-hover: rgba(255, 255, 255, 0.10);
          --fx-sep: rgba(255, 255, 255, 0.14);
          --fx-danger: #f87171;
          --fx-danger-soft: rgba(248, 113, 113, 0.16);
          --fx-pill-bg: rgba(18, 19, 25, 0.86);
          --fx-pill-text: #f8fafc;
          --fx-pill-border: rgba(255, 255, 255, 0.14);
          --fx-result-bg: #121318;
          --fx-result-head-bg: rgba(24, 25, 31, 0.90);
          --fx-result-btn-bg: rgba(255, 255, 255, 0.08);
          --fx-result-btn-hover: rgba(255, 255, 255, 0.14);
          --fx-ok-bg: rgba(16, 185, 129, 0.16);
          --fx-ok-text: #34d399;
          --fx-err-bg: rgba(239, 68, 68, 0.18);
          --fx-err-text: #fca5a5;
          --fx-swatch-light-border: rgba(255, 255, 255, 0.32);
          --fx-swatch-dark-border: rgba(255, 255, 255, 0.28);
        }
      }
      :host([data-theme="dark"]) {
        color-scheme: dark;
        --fx-accent: #fb923c;
        --fx-accent-hover: #f97316;
        --fx-accent-ink: #fb923c;
        --fx-accent-soft: rgba(251, 146, 60, 0.20);
        --fx-accent-ring: rgba(251, 146, 60, 0.44);
        --fx-bar-bg: rgba(28, 29, 36, 0.88);
        --fx-bar-solid: #21222a;
        --fx-bar-border: rgba(255, 255, 255, 0.12);
        --fx-bar-shadow: 0 14px 34px -6px rgba(0, 0, 0, 0.56), 0 2px 8px rgba(0, 0, 0, 0.30);
        --fx-text: #f1f5f9;
        --fx-muted: #94a3b8;
        --fx-hover: rgba(255, 255, 255, 0.10);
        --fx-sep: rgba(255, 255, 255, 0.14);
        --fx-danger: #f87171;
        --fx-danger-soft: rgba(248, 113, 113, 0.16);
        --fx-pill-bg: rgba(18, 19, 25, 0.86);
        --fx-pill-text: #f8fafc;
        --fx-pill-border: rgba(255, 255, 255, 0.14);
        --fx-result-bg: #121318;
        --fx-result-head-bg: rgba(24, 25, 31, 0.90);
        --fx-result-btn-bg: rgba(255, 255, 255, 0.08);
        --fx-result-btn-hover: rgba(255, 255, 255, 0.14);
        --fx-ok-bg: rgba(16, 185, 129, 0.16);
        --fx-ok-text: #34d399;
        --fx-err-bg: rgba(239, 68, 68, 0.18);
        --fx-err-text: #fca5a5;
        --fx-swatch-light-border: rgba(255, 255, 255, 0.32);
        --fx-swatch-dark-border: rgba(255, 255, 255, 0.28);
      }
      * { box-sizing: border-box; }
      .stage { position:fixed; inset:0; cursor:crosshair; pointer-events:auto; font:13px/1.3 ${UI_FONT}; color:var(--fx-text); }
      .selection { position:fixed; pointer-events:none; border:1.5px solid var(--fx-accent); box-shadow:0 0 0 99999px rgba(10, 14, 23, 0.46); background:transparent; }
      .selection.moving { cursor:move; }
      .size {
        position:absolute; left:0; top:-29px; padding:3px 8px; border-radius:6px;
        background:var(--fx-pill-bg); border:1px solid var(--fx-pill-border); color:var(--fx-pill-text);
        font:500 11.5px/1.35 ${UI_FONT}; font-variant-numeric:tabular-nums; white-space:nowrap;
        backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
        box-shadow:0 4px 12px rgba(0, 0, 0, 0.22);
      }
      .size.inside { top:6px; left:6px; }
      .handle {
        position:absolute; width:8px; height:8px; border-radius:999px;
        background:#ffffff; border:1.75px solid var(--fx-accent);
        box-shadow:0 1px 4px rgba(0, 0, 0, 0.32); pointer-events:auto;
      }
      .handle::after { content:""; position:absolute; inset:-5px; }
      .nw{left:-4px;top:-4px;cursor:nwse-resize}.n{left:50%;top:-4px;transform:translateX(-50%);cursor:ns-resize}.ne{right:-4px;top:-4px;cursor:nesw-resize}
      .e{right:-4px;top:50%;transform:translateY(-50%);cursor:ew-resize}.se{right:-4px;bottom:-4px;cursor:nwse-resize}.s{left:50%;bottom:-4px;transform:translateX(-50%);cursor:ns-resize}
      .sw{left:-4px;bottom:-4px;cursor:nesw-resize}.w{left:-4px;top:50%;transform:translateY(-50%);cursor:ew-resize}
      .mosaic-layer { position:fixed; inset:0; width:100vw; height:100vh; pointer-events:none; image-rendering:pixelated; }
      .draw-layer { position:fixed; inset:0; overflow:visible; pointer-events:none; }
      :host([data-mosaic-snap="true"]) .selection,
      :host([data-mosaic-snap="true"]) .toolbar,
      :host([data-mosaic-snap="true"]) .toolbar-sub,
      :host([data-mosaic-snap="true"]) .draw-layer,
      :host([data-mosaic-snap="true"]) .mosaic-layer,
      :host([data-mosaic-snap="true"]) .hint,
      :host([data-mosaic-snap="true"]) .inline-text-editor { opacity:0 !important; }

      .toolbar, .toolbar-sub {
        position:fixed; display:flex; align-items:center;
        background:var(--fx-bar-bg); color:var(--fx-text);
        border:1px solid var(--fx-bar-border);
        box-shadow:var(--fx-bar-shadow);
        backdrop-filter:blur(18px) saturate(1.35);
        -webkit-backdrop-filter:blur(18px) saturate(1.35);
        pointer-events:auto; user-select:none;
        font:13px/1 ${UI_FONT};
        -webkit-font-smoothing:antialiased;
      }
      .toolbar {
        gap:2px; padding:5px 6px; border-radius:11px;
        max-width:calc(100vw - 16px); flex-wrap:nowrap;
      }
      .toolbar.long-bar { gap:5px; padding:5px 7px; }
      .toolbar button, .toolbar-sub button {
        appearance:none; font:500 12.5px/1 ${UI_FONT}; color:var(--fx-text);
        border:0; background:transparent; cursor:pointer;
        display:inline-flex; align-items:center; justify-content:center;
        transition:background 0.12s ease, color 0.12s ease, transform 0.1s ease, opacity 0.12s ease;
      }
      .toolbar button:active:not(:disabled), .toolbar-sub button:active:not(:disabled) { transform:scale(0.94); }
      .toolbar button:disabled { opacity:0.34; cursor:default; }
      .toolbar button.fx-icon { width:31px; height:31px; padding:0; border-radius:7px; flex-shrink:0; }
      .toolbar button.fx-icon:hover:not(:disabled) { background:var(--fx-hover); }
      .toolbar button.fx-icon.active { background:var(--fx-accent-soft); color:var(--fx-accent-ink); }
      .toolbar button.fx-icon.fx-close:hover:not(:disabled) { background:var(--fx-danger-soft); color:var(--fx-danger); }
      .toolbar button.wide {
        height:31px; padding:0 11px; border-radius:7px; gap:5px;
        background:var(--fx-result-btn-bg); white-space:nowrap;
      }
      .toolbar button.wide:hover:not(:disabled) { background:var(--fx-result-btn-hover); }
      .toolbar button.fx-done {
        height:31px; padding:0 11px 0 9px; margin-left:2px; border-radius:8px; gap:4px;
        background:linear-gradient(135deg, #fb923c, #f97316); color:#ffffff;
        font-weight:600; white-space:nowrap;
        box-shadow:0 4px 12px -4px rgba(249, 115, 22, 0.58);
      }
      .toolbar button.fx-done:hover:not(:disabled) {
        background:linear-gradient(135deg, #f97316, #ea580c);
      }
      .toolbar .sep, .toolbar-sub .sep, .result-head .sep {
        width:1px; height:17px; background:var(--fx-sep); margin:0 4px; flex-shrink:0;
      }
      .long-status {
        padding:0 6px; font:600 12px/1.2 ${UI_FONT}; font-variant-numeric:tabular-nums;
        color:var(--fx-accent-ink); white-space:nowrap;
      }

      /* Secondary Attribute Bar */
      .toolbar-sub {
        gap:4px; padding:6px 10px; border-radius:10px; z-index:2;
      }
      .toolbar-sub[hidden] { display:none; }
      .sub-caret {
        position:absolute; top:-5px; width:9px; height:9px;
        background:var(--fx-bar-bg);
        border-left:1px solid var(--fx-bar-border);
        border-top:1px solid var(--fx-bar-border);
        clip-path:polygon(0 0, 100% 0, 0 100%);
        transform:rotate(45deg); pointer-events:none;
      }
      .toolbar-sub.above .sub-caret {
        top:auto; bottom:-5px;
        border-left:0; border-top:0;
        border-right:1px solid var(--fx-bar-border);
        border-bottom:1px solid var(--fx-bar-border);
        clip-path:polygon(100% 0, 100% 100%, 0 100%);
      }
      .sub-sizes, .sub-colors { display:flex; align-items:center; gap:3px; }
      .sub-colors { gap:6px; }
      .sub-dot-btn {
        width:26px; height:26px; border-radius:6px; padding:0;
      }
      .sub-dot-btn:hover { background:var(--fx-hover); }
      .sub-dot-btn.active { background:var(--fx-accent-soft); color:var(--fx-accent-ink); }
      .sub-dot { display:block; border-radius:999px; background:currentColor; }
      .sub-text-btn {
        min-width:26px; height:26px; padding:0 7px; border-radius:6px;
        font-size:12px; font-weight:600;
      }
      .sub-text-btn:hover { background:var(--fx-hover); }
      .sub-text-btn.active { background:var(--fx-accent-soft); color:var(--fx-accent-ink); }
      .sub-swatch {
        width:18px; height:18px; border-radius:999px; padding:0; flex-shrink:0;
        transition:transform 0.12s ease, box-shadow 0.12s ease;
      }
      .sub-swatch:hover { transform:scale(1.14); }
      .sub-swatch.is-light { border:1px solid var(--fx-swatch-light-border); }
      .sub-swatch.is-dark { border:1px solid var(--fx-swatch-dark-border); }
      .sub-swatch.active {
        box-shadow:0 0 0 2px var(--fx-bar-solid), 0 0 0 3.7px var(--fx-accent);
      }
      .sub-hint {
        font-size:11.5px; color:var(--fx-muted); padding-left:4px; white-space:nowrap;
      }

      /* In-place Text Editor */
      .inline-text-editor {
        position:fixed; z-index:5; margin:0; padding:3px 7px;
        min-width:86px; min-height:28px;
        border-radius:6px; border:1.5px dashed var(--fx-accent);
        background:rgba(255, 255, 255, 0.18);
        backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px);
        box-shadow:0 0 0 1px rgba(15, 23, 42, 0.16), 0 4px 16px rgba(0, 0, 0, 0.22);
        outline:none; resize:none; overflow:hidden;
        white-space:pre; line-height:1.3; font-weight:600;
        font-family:${UI_FONT}; caret-color:var(--fx-accent);
        pointer-events:auto;
      }
      .inline-text-editor::placeholder { color:currentColor; opacity:0.48; }
      .inline-text-editor.in-result { position:absolute; }

      .hint, .hud, .toast {
        position:fixed; left:50%; transform:translateX(-50%);
        z-index:4;
        padding:8px 14px; border-radius:10px;
        background:var(--fx-bar-bg); color:var(--fx-text);
        border:1px solid var(--fx-bar-border);
        box-shadow:var(--fx-bar-shadow);
        backdrop-filter:blur(16px) saturate(1.3);
        -webkit-backdrop-filter:blur(16px) saturate(1.3);
        pointer-events:none; font:500 12.5px/1.4 ${UI_FONT};
      }
      .hint, .hud { top:18px; }
      .toast { bottom:24px; z-index:6; }

      /* Full/Long Result Preview */
      .result {
        position:fixed; inset:0; display:flex; flex-direction:column;
        background:var(--fx-result-bg); pointer-events:auto;
        font:13.5px/1.4 ${UI_FONT}; color:var(--fx-text);
        -webkit-font-smoothing:antialiased;
      }
      .result-head {
        position:relative; z-index:3; flex:0 0 auto;
        display:flex; align-items:center; gap:8px; padding:9px 14px;
        background:var(--fx-result-head-bg);
        border-bottom:1px solid var(--fx-bar-border);
        backdrop-filter:blur(18px) saturate(1.35);
        -webkit-backdrop-filter:blur(18px) saturate(1.35);
        flex-wrap:wrap;
      }
      .result-title { display:flex; align-items:center; gap:10px; margin-right:auto; min-width:160px; }
      .result-title strong { font-size:14px; font-weight:700; white-space:nowrap; letter-spacing:-0.01em; }
      .result-status {
        display:inline-flex; align-items:center; padding:3px 9px; border-radius:999px;
        background:var(--fx-ok-bg); color:var(--fx-ok-text);
        font-size:11.5px; font-weight:500; white-space:nowrap;
      }
      .result-status:empty { display:none; }
      .result-status.error { background:var(--fx-err-bg); color:var(--fx-err-text); }
      .result-tools, .result-actions { display:flex; align-items:center; gap:3px; flex-wrap:wrap; }
      .result-tools {
        padding:3px 5px; border-radius:10px;
        background:var(--fx-result-btn-bg); border:1px solid var(--fx-bar-border);
      }
      .result-head button {
        appearance:none; height:31px; border:0; border-radius:8px; padding:0 11px;
        background:var(--fx-result-btn-bg); color:var(--fx-text);
        font:500 12.5px/1 ${UI_FONT}; cursor:pointer;
        display:inline-flex; align-items:center; justify-content:center; gap:5px;
        transition:background 0.12s ease, color 0.12s ease, transform 0.1s ease, opacity 0.12s ease;
      }
      .result-head button:active:not(:disabled) { transform:scale(0.96); }
      .result-head button:disabled { opacity:0.34; cursor:default; }
      .result-head button.tool { width:30px; height:30px; padding:0; border-radius:7px; background:transparent; }
      .result-head button.tool:hover:not(:disabled) { background:var(--fx-hover); }
      .result-head button.tool.active { background:var(--fx-accent-soft); color:var(--fx-accent-ink); }
      .result-head button.fx-icon-action { width:31px; padding:0; }
      .result-head button.fx-icon-action.fx-close:hover { background:var(--fx-danger-soft); color:var(--fx-danger); }
      .result-head button:not(.tool):not(.primary):not(.fx-close):hover:not(:disabled) { background:var(--fx-result-btn-hover); }
      .result-head button.primary {
        background:linear-gradient(135deg, #fb923c, #f97316); color:#ffffff; font-weight:600;
        box-shadow:0 4px 12px -4px rgba(249, 115, 22, 0.55);
      }
      .result-head button.primary:hover { background:linear-gradient(135deg, #f97316, #ea580c); }
      .result-body { flex:1; min-height:0; overflow:auto; padding:28px 48px 40px; text-align:center; overscroll-behavior:contain; scrollbar-gutter:stable; }
      .result-preview-shell { position:relative; display:block; margin:0 auto; line-height:0; }
      .result-preview {
        display:block; width:auto; height:auto; margin:0; border-radius:6px;
        box-shadow:0 10px 36px rgba(0, 0, 0, 0.24), 0 0 0 1px var(--fx-bar-border);
        background:#fff; user-select:none; -webkit-user-drag:none;
      }
      .result-preview.fit-width { max-width:calc(100vw - 96px); }
      .result-preview.actual-size { max-width:none; }
      .result-mosaic { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; image-rendering:pixelated; }
      .result-annotations { position:absolute; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
      .result-annotations.drawing { pointer-events:auto; cursor:crosshair; touch-action:none; }
      @media (max-width:900px) {
        .result-title { width:100%; }
      }
      @media (max-width:700px) {
        .result-body { padding:18px 20px 28px; }
        .result-preview.fit-width { max-width:calc(100vw - 40px); }
      }
      .long-origin {
        position:fixed; padding:4px 9px; border-radius:7px;
        background:var(--fx-accent); color:#ffffff;
        font:600 12px/1.3 ${UI_FONT}; pointer-events:none;
        box-shadow:0 4px 14px -4px rgba(249, 115, 22, 0.6);
      }
      .long-help { max-width:min(560px, calc(100vw - 32px)); text-align:center; }
      .handle.s.long-grip {
        width:34px; height:10px; left:50%; bottom:-6px; transform:translateX(-50%);
        border-radius:999px; background:var(--fx-accent); border:1.5px solid #ffffff;
        box-shadow:0 2px 8px rgba(249, 115, 22, 0.45);
      }
    `;
    shadow.append(style);
    if (modalShell) modalShell.append(host);
    document.documentElement.append(modalShell || host);
    ui = { host, shadow, style, foreground, topLayer, modalShell, popoverHost, backdropStyle };
    void syncThemePreference();
    if (modalShell) {
      modalShell.addEventListener("cancel", (event) => {
        event.preventDefault();
        if (activeTextEditor) { cancelActiveTextEditor(); return; }
        if (longSession) cancelLongRange().catch(() => destroyUI());
        else destroyUI();
      });
      modalShell.showModal();
    } else if (popoverHost) {
      popoverHost.showPopover();
    }
    return ui;
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const ICONS = {
    rect: [["rect", { x: 4, y: 5, width: 16, height: 14, rx: 2 }]],
    ellipse: [["ellipse", { cx: 12, cy: 12, rx: 8.5, ry: 6.5 }]],
    arrow: [["path", { d: "M5 19 19 5" }], ["path", { d: "M10 5h9v9" }]],
    brush: [["path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" }]],
    mosaic: [
      ["rect", { x: 4, y: 4, width: 16, height: 16, rx: 2.2 }],
      ["path", { d: "M4 12h16M12 4v16", opacity: "0.55" }],
      ["rect", { x: 4, y: 4, width: 8, height: 8, fill: "currentColor", "fill-opacity": "0.32", stroke: "none" }],
      ["rect", { x: 12, y: 12, width: 8, height: 8, fill: "currentColor", "fill-opacity": "0.32", stroke: "none" }]
    ],
    text: [["path", { d: "M5 6h14M12 6v13M9 19h6" }]],
    undo: [["path", { d: "M9 14 4 9l5-5" }], ["path", { d: "M4 9h10.5a5.5 5.5 0 0 1 0 11H11" }]],
    redo: [["path", { d: "m15 14 5-5-5-5" }], ["path", { d: "M20 9H9.5a5.5 5.5 0 0 0 0 11H13" }]],
    save: [
      ["path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" }],
      ["path", { d: "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" }],
      ["path", { d: "M7 3v4a1 1 0 0 0 1 1h7" }]
    ],
    copy: [["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }]],
    check: [["path", { d: "M5 12.5 10 17.5 19 7.5", "stroke-width": "2.4" }]],
    close: [["path", { d: "M6 6 18 18M18 6 6 18", "stroke-width": "1.95" }]],
    refresh: [["path", { d: "M3 12a9 9 0 1 0 3-6.7L3 8" }], ["path", { d: "M3 3v5h5" }]]
  };

  function svgIcon(name, size = 17) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of (ICONS[name] || [])) {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      svg.append(node);
    }
    return svg;
  }

  function button(label, title, onClick, extraClass = "") {
    const b = make("button", extraClass, label);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("pointerdown", (event) => event.stopPropagation());
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(event);
    });
    return b;
  }

  function iconButton(iconName, title, onClick, extraClass = "", labelText = "", iconSize = 17) {
    const b = make("button", extraClass);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.append(svgIcon(iconName, iconSize));
    if (labelText) b.append(make("span", "", labelText));
    b.addEventListener("pointerdown", (event) => event.stopPropagation());
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(event);
    });
    return b;
  }

  function createAttributeSubBar({ getActiveTool, onChange }) {
    const sub = make("div", "toolbar-sub");
    sub.hidden = true;
    // Prevent sub-bar interactions from blurring an active inline text editor.
    sub.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const caret = make("div", "sub-caret");
    const sizesWrap = make("div", "sub-sizes");
    const sep = make("span", "sep");
    const colorsWrap = make("div", "sub-colors");
    const mosaicHint = make("span", "sub-hint", t("capMosaicBrushHint", "画笔大小"));
    sub.append(caret, sizesWrap, sep, colorsWrap, mosaicHint);

    const swatchButtons = COLOR_PALETTE.map((hex) => {
      const lower = hex.toLowerCase();
      const cls = lower === "#ffffff" ? "sub-swatch is-light" : lower === "#1e293b" ? "sub-swatch is-dark" : "sub-swatch";
      const swatch = make("button", cls);
      swatch.type = "button";
      swatch.title = t("capColor", "颜色");
      swatch.dataset.color = hex;
      swatch.style.background = hex;
      swatch.addEventListener("click", (event) => {
        event.stopPropagation();
        drawColor = hex;
        sync();
        onChange?.();
      });
      colorsWrap.append(swatch);
      return swatch;
    });

    function sync() {
      const activeTool = getActiveTool();
      const show = Boolean(activeTool && activeTool !== "move" && activeTool !== "browse");
      sub.hidden = !show;
      if (!show) return;

      const isMosaic = activeTool === "mosaic";
      const isText = activeTool === "text";
      sizesWrap.replaceChildren();

      if (isText) {
        for (const preset of TEXT_PRESETS) {
          const b = make("button", "sub-text-btn", t(preset.key, preset.fallback));
          b.type = "button";
          b.title = `${preset.value}px`;
          b.classList.toggle("active", textSize === preset.value);
          b.addEventListener("click", (event) => {
            event.stopPropagation();
            textSize = preset.value;
            sync();
            onChange?.();
          });
          sizesWrap.append(b);
        }
      } else {
        const presets = isMosaic ? MOSAIC_PRESETS : STROKE_PRESETS;
        const currentValue = isMosaic ? mosaicWidth : lineWidth;
        for (const preset of presets) {
          const b = make("button", "sub-dot-btn");
          b.type = "button";
          b.title = t(preset.key, preset.fallback);
          b.classList.toggle("active", currentValue === preset.value);
          const dot = make("span", "sub-dot");
          dot.style.width = `${preset.dot}px`;
          dot.style.height = `${preset.dot}px`;
          b.append(dot);
          b.addEventListener("click", (event) => {
            event.stopPropagation();
            if (isMosaic) mosaicWidth = preset.value;
            else lineWidth = preset.value;
            sync();
            onChange?.();
          });
          sizesWrap.append(b);
        }
      }

      sep.style.display = isMosaic ? "none" : "";
      colorsWrap.style.display = isMosaic ? "none" : "flex";
      mosaicHint.style.display = isMosaic ? "" : "none";
      for (const swatch of swatchButtons) {
        swatch.classList.toggle("active", swatch.dataset.color === drawColor);
      }
    }

    return { el: sub, caret, sync };
  }

  function openInlineTextEditor({ container, x, y, maxWidth, maxHeight, fontSizePx, inResult = false, onCommit }) {
    if (activeTextEditor) {
      commitActiveTextEditor();
      return false;
    }
    const input = make("textarea", inResult ? "inline-text-editor in-result" : "inline-text-editor");
    input.rows = 1;
    input.placeholder = t("capTextPlaceholder", "输入文字…");
    input.spellcheck = false;

    const measure = make("span");
    measure.style.cssText = `position:fixed;left:-9999px;top:-9999px;visibility:hidden;white-space:pre;font-weight:600;line-height:1.3;font-family:${UI_FONT};`;

    let currentFontSize = fontSizePx;
    let editorLeft = Math.round(x);
    let editorTop = Math.round(y);
    let disposed = false;

    function updateLayout() {
      input.style.fontSize = `${currentFontSize}px`;
      input.style.color = drawColor;
      measure.style.fontSize = `${currentFontSize}px`;
      const lines = (input.value || input.placeholder).split("\n");
      let widest = 68;
      for (const line of lines) {
        measure.textContent = line || " ";
        widest = Math.max(widest, measure.getBoundingClientRect().width);
      }
      const padX = 16;
      const padY = 8;
      const lineH = currentFontSize * 1.3;
      const w = clamp(Math.ceil(widest + padX + 10), 86, Math.max(86, Math.floor(maxWidth)));
      const h = clamp(Math.ceil(lines.length * lineH + padY), Math.ceil(lineH + padY), Math.max(Math.ceil(lineH + padY), Math.floor(maxHeight)));
      input.style.left = `${editorLeft}px`;
      input.style.top = `${editorTop}px`;
      input.style.width = `${w}px`;
      input.style.height = `${h}px`;
    }

    function cleanup() {
      if (disposed) return;
      disposed = true;
      input.remove();
      measure.remove();
    }

    function commit() {
      if (disposed) return false;
      const value = input.value.replace(/\r\n/g, "\n").trimEnd();
      const saved = { text: value, left: editorLeft, top: editorTop, fontSize: currentFontSize, color: drawColor };
      cleanup();
      if (value.trim()) {
        onCommit(saved);
        return true;
      }
      return false;
    }

    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("input", updateLayout);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelActiveTextEditor();
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopImmediatePropagation();
        commitActiveTextEditor();
      }
    });

    container.append(measure, input);
    updateLayout();
    activeTextEditor = {
      el: input,
      commit,
      cleanup,
      refreshStyle(nextFontSize) {
        if (nextFontSize) currentFontSize = nextFontSize;
        updateLayout();
      }
    };
    requestAnimationFrame(() => input.focus());
    return true;
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
    if (ui.sizeLabel) {
      ui.sizeLabel.textContent = `${selection.w} × ${selection.h}`;
      ui.sizeLabel.classList.toggle("inside", selection.y < 34);
    }
    syncRegionMosaicClip();
    positionToolbar();
    renderShapes();
  }

  function positionSubBar(subBar, anchorBar, activeBtn, preferAbove = false) {
    if (!subBar || subBar.el.hidden || !anchorBar) return;
    const barRect = anchorBar.getBoundingClientRect();
    const subRect = subBar.el.getBoundingClientRect();
    const btnRect = activeBtn?.getBoundingClientRect?.();
    const anchorCenterX = btnRect ? (btnRect.left + btnRect.width / 2) : (barRect.left + 24);
    let left = clamp(barRect.left, 8, Math.max(8, innerWidth - subRect.width - 8));
    if (anchorCenterX < left + 16) left = clamp(anchorCenterX - 20, 8, Math.max(8, innerWidth - subRect.width - 8));
    if (anchorCenterX > left + subRect.width - 16) left = clamp(anchorCenterX - subRect.width + 20, 8, Math.max(8, innerWidth - subRect.width - 8));

    const belowTop = barRect.bottom + 8;
    const aboveTop = barRect.top - subRect.height - 8;
    let placeAbove = preferAbove;
    if (!placeAbove && belowTop + subRect.height > innerHeight - 8 && aboveTop >= 8) placeAbove = true;
    if (placeAbove && aboveTop < 8 && belowTop + subRect.height <= innerHeight - 8) placeAbove = false;

    const top = clamp(placeAbove ? aboveTop : belowTop, 8, Math.max(8, innerHeight - subRect.height - 8));
    subBar.el.classList.toggle("above", placeAbove);
    subBar.el.style.left = `${Math.round(left)}px`;
    subBar.el.style.top = `${Math.round(top)}px`;
    const caretLeft = clamp(Math.round(anchorCenterX - left - 5), 10, Math.max(10, Math.round(subRect.width - 19)));
    subBar.caret.style.left = `${caretLeft}px`;
  }

  function positionToolbar() {
    if (!ui?.toolbar || !selection) return;
    const toolbar = ui.toolbar;
    const rect = toolbar.getBoundingClientRect();
    const sub = ui.subBar;
    const hasSub = Boolean(sub && !sub.el.hidden);
    const subHeight = hasSub ? (sub.el.getBoundingClientRect().height || 40) : 0;
    const extraBelow = hasSub ? (subHeight + 8) : 0;

    // Dock attached to the selection's bottom-right edge; flip above when
    // the viewport bottom cannot fit the main bar (and active sub-bar).
    let left = selection.x + selection.w - rect.width;
    if (left + rect.width > innerWidth - 8) left = innerWidth - rect.width - 8;
    if (left < 8) left = Math.max(8, Math.min(selection.x, innerWidth - rect.width - 8));
    left = Math.max(8, left);

    const gap = longSession ? 14 : 8;
    let top = selection.y + selection.h + gap;
    let placedAbove = false;
    if (top + rect.height + extraBelow > innerHeight - 8) {
      const aboveMain = selection.y - rect.height - 8;
      if (aboveMain - (hasSub ? subHeight + 8 : 0) >= 8) {
        top = aboveMain;
        placedAbove = true;
      } else if (selection.y + selection.h + gap + rect.height <= innerHeight - 8) {
        top = selection.y + selection.h + gap;
      } else if (aboveMain >= 8) {
        top = aboveMain;
        placedAbove = true;
      } else {
        // Full-viewport selection: tuck inside the bottom-right corner.
        top = Math.max(8, selection.y + selection.h - rect.height - 10);
        left = clamp(selection.x + selection.w - rect.width - 10, 8, Math.max(8, innerWidth - rect.width - 8));
        placedAbove = true;
      }
    }
    top = clamp(top, 8, Math.max(8, innerHeight - rect.height - 8));
    toolbar.style.left = `${Math.round(left)}px`;
    toolbar.style.top = `${Math.round(top)}px`;
    toolbar.style.visibility = "visible";

    if (hasSub) {
      const activeBtn = toolbar.querySelector(`button[data-tool="${tool}"]`);
      positionSubBar(sub, toolbar, activeBtn, placedAbove);
    }
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
    } else if (tool === "text") {
      ui.stage.style.cursor = "text";
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

  function syncRegionMosaicClip() {
    if (!ui?.mosaicCanvas) return;
    if (!selection) {
      ui.mosaicCanvas.style.clipPath = "inset(100%)";
      return;
    }
    const top = Math.max(0, selection.y);
    const left = Math.max(0, selection.x);
    const right = Math.max(0, innerWidth - (selection.x + selection.w));
    const bottom = Math.max(0, innerHeight - (selection.y + selection.h));
    ui.mosaicCanvas.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
  }

  function buildMosaicCacheFromImage(image, logicalWidth, logicalHeight, maxWidth = 2400, maxHeight = 8192) {
    const srcW = image.naturalWidth || image.width;
    const srcH = image.naturalHeight || image.height;
    if (!srcW || !srcH || !logicalWidth || !logicalHeight) return null;
    const downscale = Math.min(1, maxWidth / srcW, maxHeight / srcH);
    const width = Math.max(1, Math.round(srcW * downscale));
    const height = Math.max(1, Math.round(srcH * downscale));
    const scaleX = width / logicalWidth;
    const scaleY = height / logicalHeight;
    const block = Math.max(4, Math.round(10 * scaleX));

    // Read pixels once on a single temporary canvas to avoid canvas-to-canvas
    // taint issues in Firefox and keep live painting under 0.1ms per move.
    const scratch = createCanvas(width, height);
    const sctx = scratch.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(image, 0, 0, width, height);
    const pixels = sctx.getImageData(0, 0, width, height).data;

    const cols = Math.ceil(width / block);
    const rows = Math.ceil(height / block);
    const colors = new Uint8Array(cols * rows * 3);
    for (let by = 0; by < rows; by += 1) {
      const sy = by * block;
      const ey = Math.min(height, sy + block);
      for (let bx = 0; bx < cols; bx += 1) {
        const sx = bx * block;
        const ex = Math.min(width, sx + block);
        let r = 0, g = 0, b = 0, count = 0;
        for (let y = sy; y < ey; y += 1) {
          for (let x = sx; x < ex; x += 1) {
            const p = (y * width + x) * 4;
            r += pixels[p]; g += pixels[p + 1]; b += pixels[p + 2]; count += 1;
          }
        }
        const out = (by * cols + bx) * 3;
        if (count) {
          colors[out] = Math.round(r / count);
          colors[out + 1] = Math.round(g / count);
          colors[out + 2] = Math.round(b / count);
        }
      }
    }
    return { width, height, scaleX, scaleY, block, cols, rows, colors };
  }

  function paintMosaicPoints(ctx, cache, points, brushWidth) {
    if (!ctx || !cache || !points?.length) return;
    const widthPx = Math.max(1, (brushWidth || mosaicWidth) * cache.scaleX);
    const radius = Math.max(1, widthPx / 2);
    const xs = points.map((p) => p.x * cache.scaleX);
    const ys = points.map((p) => p.y * cache.scaleY);
    const left = clamp(Math.floor(Math.min(...xs) - radius - 2), 0, cache.width);
    const top = clamp(Math.floor(Math.min(...ys) - radius - 2), 0, cache.height);
    const right = clamp(Math.ceil(Math.max(...xs) + radius + 2), 0, cache.width);
    const bottom = clamp(Math.ceil(Math.max(...ys) + radius + 2), 0, cache.height);
    const w = right - left;
    const h = bottom - top;
    if (w <= 0 || h <= 0) return;

    const mask = createCanvas(w, h);
    const mctx = mask.getContext("2d", { willReadFrequently: true });
    mctx.strokeStyle = "#fff";
    mctx.fillStyle = "#fff";
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.lineWidth = widthPx;
    mctx.beginPath();
    if (points.length === 1) {
      mctx.arc(xs[0] - left, ys[0] - top, radius, 0, Math.PI * 2);
      mctx.fill();
    } else {
      points.forEach((_, i) => {
        const x = xs[i] - left;
        const y = ys[i] - top;
        if (i) mctx.lineTo(x, y); else mctx.moveTo(x, y);
      });
      mctx.stroke();
    }

    const maskData = mctx.getImageData(0, 0, w, h).data;
    const outImg = ctx.getImageData(left, top, w, h);
    const out = outImg.data;
    const { block, cols, colors } = cache;
    for (let y = 0; y < h; y += 1) {
      const rowOffset = Math.floor((top + y) / block) * cols;
      for (let x = 0; x < w; x += 1) {
        const idx = (y * w + x) * 4;
        if (!maskData[idx + 3]) continue;
        const cIdx = (rowOffset + Math.floor((left + x) / block)) * 3;
        out[idx] = colors[cIdx];
        out[idx + 1] = colors[cIdx + 1];
        out[idx + 2] = colors[cIdx + 2];
        out[idx + 3] = 255;
      }
    }
    ctx.putImageData(outImg, left, top);
  }

  function renderMosaicLayer(canvas, cache, shapeList, previewShape) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    if (!cache) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (canvas.width !== cache.width || canvas.height !== cache.height) {
      canvas.width = cache.width;
      canvas.height = cache.height;
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    for (const shape of shapeList) {
      if (shape.type === "mosaic") paintMosaicPoints(ctx, cache, shape.points, shape.width);
    }
    if (previewShape?.type === "mosaic") {
      paintMosaicPoints(ctx, cache, previewShape.points, previewShape.width);
    }
  }

  function ensureMosaicFallbackPattern(svg) {
    const defs = document.createElementNS(NS, "defs");
    const pattern = document.createElementNS(NS, "pattern");
    pattern.setAttribute("id", "foxshot-mosaic-fallback");
    pattern.setAttribute("width", "12");
    pattern.setAttribute("height", "12");
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    const cells = [
      [0, 0, "#cbd5e1"], [6, 0, "#64748b"],
      [0, 6, "#64748b"], [6, 6, "#cbd5e1"]
    ];
    for (const [x, y, fill] of cells) {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(x));
      r.setAttribute("y", String(y));
      r.setAttribute("width", "6");
      r.setAttribute("height", "6");
      r.setAttribute("fill", fill);
      r.setAttribute("fill-opacity", "0.86");
      pattern.append(r);
    }
    defs.append(pattern);
    svg.append(defs);
  }

  async function captureRegionMosaicSnapshot() {
    const shown = ui;
    if (!shown?.host?.isConnected) return null;
    shown.host.dataset.mosaicSnap = "true";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      return await browser.runtime.sendMessage({ type: "foxshot.captureVisible", scale: 1 });
    } finally {
      if (ui === shown && shown.host?.isConnected) delete shown.host.dataset.mosaicSnap;
    }
  }

  async function ensureRegionMosaicCache() {
    const shown = ui;
    if (!shown || shown.mosaicCache || shown.mosaicLoading || shown.mosaicFailed) return;
    shown.mosaicLoading = true;
    try {
      const dataUrl = await captureRegionMosaicSnapshot();
      if (!dataUrl || ui !== shown || !shown.host?.isConnected) return;
      const image = await loadImage(dataUrl);
      if (ui !== shown || !shown.host?.isConnected) return;
      shown.mosaicCache = buildMosaicCacheFromImage(image, innerWidth, innerHeight, 3840, 3840);
      if (shown.mosaicCache && shown.mosaicCanvas) {
        shown.mosaicCanvas.width = shown.mosaicCache.width;
        shown.mosaicCanvas.height = shown.mosaicCache.height;
        syncRegionMosaicClip();
        renderShapes();
      }
    } catch (_) {
      if (ui === shown) shown.mosaicFailed = true;
    } finally {
      if (ui === shown) shown.mosaicLoading = false;
    }
  }

  function scheduleRegionMosaicCache(delayMs = 60) {
    if (!ui || ui.mosaicCache || ui.mosaicLoading || ui.mosaicFailed) return;
    if (ui.mosaicTimer) clearTimeout(ui.mosaicTimer);
    ui.mosaicTimer = setTimeout(() => {
      if (ui) ui.mosaicTimer = null;
      if (ui && !interaction && (tool === "mosaic" || shapes.some((s) => s.type === "mosaic"))) {
        void ensureRegionMosaicCache();
      }
    }, delayMs);
  }

  function buildDrawLayer() {
    const mosaicCanvas = createCanvas(Math.max(1, innerWidth), Math.max(1, innerHeight));
    mosaicCanvas.className = "mosaic-layer";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "draw-layer");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    ui.shadow.append(mosaicCanvas, svg);
    ui.mosaicCanvas = mosaicCanvas;
    ui.svg = svg;
    syncRegionMosaicClip();
  }

  function shapeNode(shape, options = {}) {
    let node;
    const common = { stroke: shape.color || drawColor, "stroke-width": String(shape.width || lineWidth), fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (shape.type === "rect") {
      node = document.createElementNS(NS, "rect");
      const r = normalizeRect(shape.a, shape.b);
      node.setAttribute("x", r.x); node.setAttribute("y", r.y); node.setAttribute("width", r.w); node.setAttribute("height", r.h);
      node.setAttribute("rx", "2");
    } else if (shape.type === "mosaic") {
      if (options.liveMosaic) return null;
      const strokeW = shape.width || mosaicWidth;
      if (shape.points.length === 1) {
        node = document.createElementNS(NS, "circle");
        node.setAttribute("cx", shape.points[0].x);
        node.setAttribute("cy", shape.points[0].y);
        node.setAttribute("r", String(strokeW / 2));
        common.fill = "url(#foxshot-mosaic-fallback)";
        delete common.stroke;
        delete common["stroke-width"];
      } else {
        node = document.createElementNS(NS, "polyline");
        node.setAttribute("points", shape.points.map((p) => `${p.x},${p.y}`).join(" "));
        common.stroke = "url(#foxshot-mosaic-fallback)";
        common["stroke-width"] = String(strokeW);
        common["stroke-linecap"] = "round";
        common["stroke-linejoin"] = "round";
      }
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
      const fontSize = shape.size || textSize;
      const lineHeight = fontSize * 1.3;
      node.setAttribute("x", shape.at.x);
      node.setAttribute("y", shape.at.y);
      node.setAttribute("fill", shape.color || drawColor);
      node.setAttribute("font-family", UI_FONT);
      node.setAttribute("font-size", String(fontSize));
      node.setAttribute("font-weight", "600");
      const lines = String(shape.text || "").split("\n");
      lines.forEach((line, index) => {
        const tspan = document.createElementNS(NS, "tspan");
        tspan.setAttribute("x", shape.at.x);
        tspan.setAttribute("dy", index === 0 ? "0" : String(lineHeight));
        tspan.textContent = line;
        node.append(tspan);
      });
      delete common.stroke; delete common["stroke-width"]; delete common.fill;
    }
    if (!node) return null;
    for (const [key, value] of Object.entries(common)) node.setAttribute(key, value);
    return node;
  }

  function syncRegionHistoryButtons() {
    if (ui?.undoBtn) ui.undoBtn.disabled = shapes.length === 0;
    if (ui?.redoBtn) ui.redoBtn.disabled = redoShapes.length === 0;
  }

  function renderShapes() {
    if (!ui?.svg) return;
    const liveMosaic = Boolean(ui.mosaicCache && ui.mosaicCanvas);
    renderMosaicLayer(ui.mosaicCanvas, ui.mosaicCache, shapes, interaction?.previewShape);
    ui.svg.replaceChildren();
    const needsFallback = !liveMosaic && (
      shapes.some((s) => s.type === "mosaic") || interaction?.previewShape?.type === "mosaic"
    );
    if (needsFallback) ensureMosaicFallbackPattern(ui.svg);
    for (const shape of shapes) {
      const node = shapeNode(shape, { liveMosaic });
      if (node) ui.svg.append(node);
    }
    if (interaction?.previewShape) {
      const node = shapeNode(interaction.previewShape, { liveMosaic });
      if (node) ui.svg.append(node);
    }
    syncRegionHistoryButtons();
  }

  function pushShape(shape) {
    shapes.push(shape);
    redoShapes = [];
    renderShapes();
  }

  function setTool(next) {
    commitActiveTextEditor();
    if (ui?.mosaicTimer && next !== "mosaic") {
      clearTimeout(ui.mosaicTimer);
      ui.mosaicTimer = null;
    }
    tool = next;
    if (!ui?.toolbar) return;
    for (const b of ui.toolbar.querySelectorAll("button[data-tool]")) {
      b.classList.toggle("active", b.dataset.tool === next);
    }
    if (ui.selectionEl) ui.selectionEl.classList.toggle("moving", next === "move");
    ui.subBar?.sync();
    positionToolbar();
    updateStageCursor();
    if (next === "mosaic") scheduleRegionMosaicCache(60);
  }

  function buildRegionToolbar() {
    const bar = make("div", "toolbar");
    bar.style.visibility = "hidden";
    const tools = [
      ["rect", t("capRectangle", "矩形")],
      ["ellipse", t("capEllipse", "椭圆")],
      ["arrow", t("capArrow", "箭头")],
      ["brush", t("capPen", "画笔")],
      ["mosaic", t("capMosaic", "马赛克")],
      ["text", t("capText", "文字")]
    ];
    for (const [name, title] of tools) {
      const b = iconButton(name, title, () => setTool(tool === name ? "move" : name), "fx-icon");
      b.dataset.tool = name;
      bar.append(b);
    }

    bar.append(make("span", "sep"));
    const undoBtn = iconButton("undo", t("capUndoShortcutHint", "撤销 (Ctrl+Z)"), () => {
      commitActiveTextEditor();
      if (shapes.length) { redoShapes.push(shapes.pop()); renderShapes(); }
    }, "fx-icon", "", 16);
    const redoBtn = iconButton("redo", t("capRedoShortcutHint", "重做 (Ctrl+Y)"), () => {
      commitActiveTextEditor();
      if (redoShapes.length) { shapes.push(redoShapes.pop()); renderShapes(); }
    }, "fx-icon", "", 16);
    bar.append(undoBtn, redoBtn);

    bar.append(make("span", "sep"));
    const saveBtn = iconButton("save", t("capSavePng", "保存 PNG"), () => finalizeRegion("save"), "fx-icon", "", 16);
    const cancelBtn = iconButton("close", t("capCancelShortcutHint", "取消 (Esc)"), destroyUI, "fx-icon fx-close", "", 16);
    const copyBtn = iconButton("check", t("capCopyShortcutHint", "复制到剪贴板 (Enter)"), () => finalizeRegion("copy"), "fx-done", t("capCopy", "复制"), 15);
    bar.append(saveBtn, cancelBtn, copyBtn);

    const subBar = createAttributeSubBar({
      getActiveTool: () => tool,
      onChange: () => {
        if (activeTextEditor && tool === "text") activeTextEditor.refreshStyle(textSize);
        positionToolbar();
      }
    });

    ui.shadow.append(bar, subBar.el);
    ui.toolbar = bar;
    ui.subBar = subBar;
    ui.undoBtn = undoBtn;
    ui.redoBtn = redoBtn;
    syncRegionHistoryButtons();
    setTool(tool);
    requestAnimationFrame(() => positionToolbar());
  }

  function beginResize(event, dir) {
    commitActiveTextEditor();
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
    let committedMosaic = false;
    if (!cancelled && interaction.type === "shape") {
      const shape = interaction.previewShape;
      const valid = shape && (
        shape.type === "mosaic"
          ? shape.points.length >= 1
          : shape.type === "brush"
            ? shape.points.length > 1
            : Math.hypot(shape.b.x - shape.a.x, shape.b.y - shape.a.y) > 3
      );
      if (valid) {
        shapes.push(shape);
        redoShapes = [];
        if (shape.type === "mosaic") committedMosaic = true;
      }
    }
    interaction = null;
    releasePointer(event);
    renderShapes();
    positionToolbar();
    updateStageCursor(point(event));
    if (committedMosaic && ui && !ui.mosaicCache && !ui.mosaicLoading && !ui.mosaicFailed) {
      void ensureRegionMosaicCache();
    }
  }

  function startRegion() {
    shapes = []; redoShapes = []; selection = null; tool = "move";
    mountBase();
    const stage = make("div", "stage");
    const hint = make("div", "hint", t("capSelectRegionHint", "拖动鼠标框选区域；松开后可调整大小并标注"));
    ui.shadow.append(stage, hint);
    ui.stage = stage; ui.hint = hint;
    buildDrawLayer();

    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const p = point(event);

      if (activeTextEditor) {
        commitActiveTextEditor();
        event.preventDefault();
        return;
      }

      if (selection && inside(p, selection)) {
        if (tool === "move") {
          interaction = { type:"move", start:p, original:clone(selection) };
          capturePointer(event);
        } else if (tool === "text") {
          const left = clamp(p.x - 7, selection.x + 2, Math.max(selection.x + 2, selection.x + selection.w - 90));
          const top = clamp(p.y - textSize * 0.65, selection.y + 2, Math.max(selection.y + 2, selection.y + selection.h - textSize - 10));
          openInlineTextEditor({
            container: ui.shadow,
            x: left,
            y: top,
            maxWidth: Math.max(90, selection.x + selection.w - left - 4),
            maxHeight: Math.max(textSize * 1.6, selection.y + selection.h - top - 4),
            fontSizePx: textSize,
            onCommit: ({ text, left: lx, top: ty, fontSize, color }) => {
              pushShape({ type: "text", at: { x: lx + 7, y: ty + 3 + fontSize * 0.92 }, text, color, size: fontSize });
            }
          });
        } else if (tool === "brush" || tool === "mosaic") {
          if (tool === "mosaic" && ui.mosaicTimer) {
            clearTimeout(ui.mosaicTimer);
            ui.mosaicTimer = null;
          }
          const previewShape = {
            type: tool,
            points: [p],
            color: drawColor,
            width: tool === "mosaic" ? mosaicWidth : lineWidth
          };
          interaction = { type: "shape", previewShape };
          capturePointer(event);
          if (tool === "mosaic") {
            if (ui.mosaicCache && ui.mosaicCanvas) {
              paintMosaicPoints(ui.mosaicCanvas.getContext("2d", { willReadFrequently: true }), ui.mosaicCache, [p], previewShape.width);
            } else {
              renderShapes();
            }
          }
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

    stage.addEventListener("dblclick", (event) => {
      if (tool !== "move" || activeTextEditor || !selection) return;
      if (inside(point(event), selection)) {
        event.preventDefault();
        void finalizeRegion("copy");
      }
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
        const shape = interaction.previewShape;
        if (shape.type === "mosaic") {
          const prev = shape.points[shape.points.length - 1];
          shape.points.push(p);
          if (ui.mosaicCache && ui.mosaicCanvas) {
            paintMosaicPoints(ui.mosaicCanvas.getContext("2d", { willReadFrequently: true }), ui.mosaicCache, prev ? [prev, p] : [p], shape.width);
            return;
          }
        } else if (shape.type === "brush") {
          shape.points.push(p);
        } else {
          shape.b = p;
        }
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
    const shown = ui;
    const previous = shown.host.style.display;
    if (shown.modalShell?.open) shown.modalShell.close();
    if (shown.popoverHost?.matches(":popover-open")) shown.popoverHost.hidePopover();
    shown.host.style.display = "none";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      return await browser.runtime.sendMessage({ type:"foxshot.captureVisible", ...(scale ? { scale } : {}) });
    } finally {
      if (ui === shown && shown.host.isConnected) {
        shown.host.style.display = previous;
        if (shown.modalShell && !shown.modalShell.open) shown.modalShell.showModal();
        else if (shown.popoverHost && !shown.popoverHost.matches(":popover-open")) shown.popoverHost.showPopover();
      }
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
    const strokeW = Math.max(1, (shape.width || mosaicWidth) * scale);
    const radius = Math.max(1, strokeW / 2);
    const xs = shape.points.map((p) => (p.x - ox) * scale);
    const ys = shape.points.map((p) => (p.y - oy) * scale);
    const left = clamp(Math.floor(Math.min(...xs) - radius - 2), 0, canvas.width);
    const top = clamp(Math.floor(Math.min(...ys) - radius - 2), 0, canvas.height);
    const right = clamp(Math.ceil(Math.max(...xs) + radius + 2), 0, canvas.width);
    const bottom = clamp(Math.ceil(Math.max(...ys) + radius + 2), 0, canvas.height);
    if (right <= left || bottom <= top) return;

    const block = Math.max(6, Math.round(10 * scale));
    const gridOx = Math.round(ox * scale);
    const gridOy = Math.round(oy * scale);
    const startGx = Math.floor((gridOx + left) / block) * block;
    const startGy = Math.floor((gridOy + top) / block) * block;
    const endGx = Math.ceil((gridOx + right) / block) * block;
    const endGy = Math.ceil((gridOy + bottom) / block) * block;
    const readLeft = clamp(startGx - gridOx, 0, canvas.width);
    const readTop = clamp(startGy - gridOy, 0, canvas.height);
    const readRight = clamp(endGx - gridOx, readLeft, canvas.width);
    const readBottom = clamp(endGy - gridOy, readTop, canvas.height);
    const readWidth = readRight - readLeft;
    const readHeight = readBottom - readTop;
    if (!readWidth || !readHeight) return;

    const mask = createCanvas(readWidth, readHeight);
    const mctx = mask.getContext("2d", { willReadFrequently: true });
    mctx.strokeStyle = "#fff";
    mctx.fillStyle = "#fff";
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.lineWidth = strokeW;
    mctx.beginPath();
    shape.points.forEach((p, i) => {
      const x = (p.x - ox) * scale - readLeft;
      const y = (p.y - oy) * scale - readTop;
      if (i) mctx.lineTo(x, y); else mctx.moveTo(x, y);
    });
    if (shape.points.length === 1) {
      const p = shape.points[0];
      mctx.arc((p.x - ox) * scale - readLeft, (p.y - oy) * scale - readTop, radius, 0, Math.PI * 2);
      mctx.fill();
    } else {
      mctx.stroke();
    }

    const imageData = ctx.getImageData(readLeft, readTop, readWidth, readHeight);
    const maskData = mctx.getImageData(0, 0, readWidth, readHeight).data;
    const pixels = imageData.data;

    for (let gy = startGy; gy < endGy; gy += block) {
      const by = clamp(gy - gridOy - readTop, 0, readHeight);
      const ey = clamp(gy + block - gridOy - readTop, by, readHeight);
      if (ey <= by) continue;
      for (let gx = startGx; gx < endGx; gx += block) {
        const bx = clamp(gx - gridOx - readLeft, 0, readWidth);
        const ex = clamp(gx + block - gridOx - readLeft, bx, readWidth);
        if (ex <= bx) continue;
        let touchesMask = false;
        let r = 0, g = 0, b = 0, count = 0;
        for (let y = by; y < ey; y += 1) {
          for (let x = bx; x < ex; x += 1) {
            const i = (y * readWidth + x) * 4;
            if (maskData[i + 3]) touchesMask = true;
            r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; count += 1;
          }
        }
        if (!touchesMask || !count) continue;
        r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
        for (let y = by; y < ey; y += 1) {
          for (let x = bx; x < ex; x += 1) {
            const i = (y * readWidth + x) * 4;
            if (!maskData[i + 3]) continue;
            pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b;
          }
        }
      }
    }
    ctx.putImageData(imageData, readLeft, readTop);
  }

  function renderAnnotationList(canvas, shapeList, scale, ox, oy) {
    const ctx = canvas.getContext("2d");
    for (const shape of shapeList.filter((s) => s.type === "mosaic")) pixelateStroke(ctx, shape, scale, ox, oy, canvas);
    for (const shape of shapeList.filter((s) => s.type !== "mosaic")) {
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
        const fontSize = (shape.size || textSize) * scale;
        const lineHeight = fontSize * 1.3;
        ctx.font = `600 ${fontSize}px ${UI_FONT}`;
        ctx.textBaseline = "alphabetic";
        const lines = String(shape.text || "").split("\n");
        lines.forEach((line, index) => {
          ctx.fillText(line, (shape.at.x - ox) * scale, (shape.at.y - oy) * scale + index * lineHeight);
        });
      }
      ctx.restore();
    }
  }

  function renderAnnotations(canvas, scale, ox, oy) {
    renderAnnotationList(canvas, shapes, scale, ox, oy);
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
      commitActiveTextEditor();
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

  function resultPoint(editor, event) {
    const rect = editor.image.getBoundingClientRect();
    if (!rect.width || !rect.height || !editor.image.naturalWidth || !editor.image.naturalHeight) return null;
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    return {
      x: x * editor.image.naturalWidth / rect.width,
      y: y * editor.image.naturalHeight / rect.height
    };
  }

  function resultDisplayScale(editor) {
    const rect = editor.image.getBoundingClientRect();
    return rect.width > 0 ? editor.image.naturalWidth / rect.width : 1;
  }

  function syncResultPreviewSize(editor) {
    if (!editor?.image?.isConnected || !editor.shell?.isConnected) return;
    requestAnimationFrame(() => {
      if (!editor?.image?.isConnected || !editor.shell?.isConnected) return;
      editor.shell.style.width = `${editor.image.clientWidth}px`;
      editor.shell.style.height = `${editor.image.clientHeight}px`;
      if (editor.image.naturalWidth && editor.image.naturalHeight) {
        editor.svg.setAttribute("viewBox", `0 0 ${editor.image.naturalWidth} ${editor.image.naturalHeight}`);
      }
      positionResultSubBar(editor);
    });
  }

  function syncResultHistoryButtons(editor) {
    if (editor?.undoBtn) editor.undoBtn.disabled = editor.shapes.length === 0;
    if (editor?.redoBtn) editor.redoBtn.disabled = editor.redo.length === 0;
  }

  function ensureResultMosaicCache(editor) {
    if (!editor || editor.mosaicCache || editor.mosaicFailed) return editor?.mosaicCache || null;
    if (!editor.image?.complete || !editor.image.naturalWidth || !editor.image.naturalHeight) return null;
    try {
      editor.mosaicCache = buildMosaicCacheFromImage(
        editor.image,
        editor.image.naturalWidth,
        editor.image.naturalHeight,
        2400,
        8192
      );
      if (editor.mosaicCache && editor.mosaicCanvas) {
        editor.mosaicCanvas.width = editor.mosaicCache.width;
        editor.mosaicCanvas.height = editor.mosaicCache.height;
      }
    } catch (_) {
      editor.mosaicFailed = true;
    }
    return editor.mosaicCache || null;
  }

  function renderResultShapes(editor) {
    if (!editor?.svg) return;
    const hasMosaic = editor.shapes.some((s) => s.type === "mosaic")
      || editor.interaction?.previewShape?.type === "mosaic";
    if (hasMosaic && !editor.mosaicCache) ensureResultMosaicCache(editor);
    const liveMosaic = Boolean(editor.mosaicCache && editor.mosaicCanvas);
    renderMosaicLayer(editor.mosaicCanvas, editor.mosaicCache, editor.shapes, editor.interaction?.previewShape);
    editor.svg.replaceChildren();
    if (!liveMosaic && hasMosaic) ensureMosaicFallbackPattern(editor.svg);
    for (const shape of editor.shapes) {
      const node = shapeNode(shape, { liveMosaic });
      if (node) editor.svg.append(node);
    }
    if (editor.interaction?.previewShape) {
      const node = shapeNode(editor.interaction.previewShape, { liveMosaic });
      if (node) editor.svg.append(node);
    }
    syncResultHistoryButtons(editor);
  }

  function markResultAnnotationsChanged(editor) {
    editor.status.classList.remove("error");
    editor.status.textContent = editor.shapes.length
      ? t("capAnnotationsAdded", "已添加标注；复制/保存会包含标注")
      : t("capAnnotationsCleared", "标注已清空");
  }

  function positionResultSubBar(editor) {
    if (!editor?.subBar || editor.subBar.el.hidden || !editor.tools) return;
    const activeBtn = editor.tools.querySelector(`button[data-result-tool="${editor.tool}"]`);
    positionSubBar(editor.subBar, editor.tools, activeBtn, false);
  }

  function setResultTool(editor, next) {
    commitActiveTextEditor();
    editor.tool = next;
    editor.svg.classList.toggle("drawing", next !== "browse");
    editor.svg.style.cursor = next === "text" ? "text" : "crosshair";
    for (const item of editor.tools.querySelectorAll("button[data-result-tool]")) {
      item.classList.toggle("active", item.dataset.resultTool === next);
    }
    editor.subBar?.sync();
    if (next === "mosaic") ensureResultMosaicCache(editor);
    requestAnimationFrame(() => positionResultSubBar(editor));
  }

  function finishResultPointer(editor, event, cancelled = false) {
    const current = editor.interaction;
    if (!current) return;
    if (!cancelled && current.previewShape) {
      const shape = current.previewShape;
      const valid = shape.type === "mosaic"
        ? shape.points.length >= 1
        : shape.type === "brush"
          ? shape.points.length > 1
          : Math.hypot(shape.b.x - shape.a.x, shape.b.y - shape.a.y) > 3;
      if (valid) {
        editor.shapes.push(shape);
        editor.redo = [];
        markResultAnnotationsChanged(editor);
      }
    }
    try {
      if (editor.svg.hasPointerCapture?.(event.pointerId)) editor.svg.releasePointerCapture(event.pointerId);
    } catch (_) {}
    editor.interaction = null;
    renderResultShapes(editor);
  }

  function bindResultDrawing(editor) {
    editor.svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || editor.tool === "browse") return;
      if (activeTextEditor) {
        commitActiveTextEditor();
        event.preventDefault();
        return;
      }
      const p = resultPoint(editor, event);
      if (!p) return;
      const scale = resultDisplayScale(editor);
      if (editor.tool === "text") {
        const rect = editor.image.getBoundingClientRect();
        const localX = clamp(event.clientX - rect.left - 7, 2, Math.max(2, rect.width - 90));
        const localY = clamp(event.clientY - rect.top - textSize * 0.65, 2, Math.max(2, rect.height - textSize - 10));
        openInlineTextEditor({
          container: editor.shell,
          x: localX,
          y: localY,
          maxWidth: Math.max(90, rect.width - localX - 4),
          maxHeight: Math.max(textSize * 1.6, rect.height - localY - 4),
          fontSizePx: textSize,
          inResult: true,
          onCommit: ({ text, left: lx, top: ty, fontSize, color }) => {
            const currentScale = resultDisplayScale(editor);
            editor.shapes.push({
              type: "text",
              at: { x: (lx + 7) * currentScale, y: (ty + 3 + fontSize * 0.92) * currentScale },
              text,
              color,
              size: fontSize * currentScale
            });
            editor.redo = [];
            renderResultShapes(editor);
            markResultAnnotationsChanged(editor);
          }
        });
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (editor.tool === "brush" || editor.tool === "mosaic") {
        const previewShape = {
          type: editor.tool,
          points: [p],
          color: drawColor,
          width: (editor.tool === "mosaic" ? mosaicWidth : lineWidth) * scale
        };
        editor.interaction = { previewShape };
        if (editor.tool === "mosaic") {
          const cache = ensureResultMosaicCache(editor);
          if (cache && editor.mosaicCanvas) {
            paintMosaicPoints(editor.mosaicCanvas.getContext("2d", { willReadFrequently: true }), cache, [p], previewShape.width);
          } else {
            renderResultShapes(editor);
          }
        }
      } else {
        editor.interaction = { previewShape:{ type:editor.tool, a:p, b:p, color:drawColor, width:lineWidth * scale } };
      }
      try { editor.svg.setPointerCapture?.(event.pointerId); } catch (_) {}
      event.preventDefault();
      event.stopPropagation();
    });

    editor.svg.addEventListener("pointermove", (event) => {
      if (!editor.interaction?.previewShape) return;
      const p = resultPoint(editor, event);
      if (!p) return;
      const shape = editor.interaction.previewShape;
      if (shape.type === "mosaic") {
        const prev = shape.points[shape.points.length - 1];
        shape.points.push(p);
        if (editor.mosaicCache && editor.mosaicCanvas) {
          paintMosaicPoints(editor.mosaicCanvas.getContext("2d", { willReadFrequently: true }), editor.mosaicCache, prev ? [prev, p] : [p], shape.width);
          event.preventDefault();
          return;
        }
      } else if (shape.type === "brush") {
        shape.points.push(p);
      } else {
        shape.b = p;
      }
      renderResultShapes(editor);
      event.preventDefault();
    });
    editor.svg.addEventListener("pointerup", (event) => finishResultPointer(editor, event));
    editor.svg.addEventListener("pointercancel", (event) => finishResultPointer(editor, event, true));
    editor.svg.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  async function buildResultDataUrl(editor) {
    commitActiveTextEditor();
    if (!editor.shapes.length) return editor.originalDataUrl;
    const image = await loadImage(editor.originalDataUrl);
    const canvas = createCanvas(image.naturalWidth || image.width, image.naturalHeight || image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    renderAnnotationList(canvas, editor.shapes, 1, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function undoResultAnnotation(editor) {
    commitActiveTextEditor();
    if (!editor.shapes.length) return;
    editor.redo.push(editor.shapes.pop());
    renderResultShapes(editor);
    markResultAnnotationsChanged(editor);
  }
  function redoResultAnnotation(editor) {
    commitActiveTextEditor();
    if (!editor.redo.length) return;
    editor.shapes.push(editor.redo.pop());
    renderResultShapes(editor);
    markResultAnnotationsChanged(editor);
  }

  function buildResultAnnotationTools(editor) {
    const tools = make("div", "result-tools");
    const toolDefs = [
      ["rect", t("capRectangle", "矩形")],
      ["ellipse", t("capEllipse", "椭圆")],
      ["arrow", t("capArrow", "箭头")],
      ["brush", t("capPen", "画笔")],
      ["mosaic", t("capMosaic", "马赛克")],
      ["text", t("capText", "文字")]
    ];
    for (const [name, title] of toolDefs) {
      const item = iconButton(name, title, () => setResultTool(editor, editor.tool === name ? "browse" : name), "tool");
      item.dataset.resultTool = name;
      tools.append(item);
    }
    tools.append(make("span", "sep"));
    const undoBtn = iconButton("undo", t("capUndoShortcutHint", "撤销 (Ctrl+Z)"), () => undoResultAnnotation(editor), "tool", "", 16);
    const redoBtn = iconButton("redo", t("capRedoShortcutHint", "重做 (Ctrl+Y)"), () => redoResultAnnotation(editor), "tool", "", 16);
    tools.append(undoBtn, redoBtn);
    editor.tools = tools;
    editor.undoBtn = undoBtn;
    editor.redoBtn = redoBtn;
    syncResultHistoryButtons(editor);
    return tools;
  }

  function showResultDataUrl(dataUrl, title, filenameBase, autoCopy = true) {
    if (!ui) mountBase();
    cancelActiveTextEditor();
    releasePointer();
    lockResultPageScroll();
    ui.host.style.display = "";
    for (const child of [...ui.shadow.children]) {
      if (child !== ui.style) child.remove();
    }
    ui.selectionEl = null; ui.sizeLabel = null; ui.svg = null; ui.mosaicCanvas = null; ui.stage = null; ui.toolbar = null; ui.subBar = null; ui.hint = null;
    const wrap = make("div", "result");
    const head = make("div", "result-head");
    const titleGroup = make("div", "result-title");
    const name = make("strong", "", title);
    const status = make("span", "result-status", autoCopy ? t("capCopyingClipboard", "正在复制到剪贴板…") : "");
    titleGroup.append(name, status);
    const body = make("div", "result-body");
    const shell = make("div", "result-preview-shell");
    const image = document.createElement("img");
    image.crossOrigin = "anonymous";
    image.className = "result-preview fit-width";
    image.alt = title;
    image.draggable = false;
    const mosaicCanvas = createCanvas(1, 1);
    mosaicCanvas.className = "result-mosaic";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "result-annotations");
    svg.setAttribute("preserveAspectRatio", "none");
    shell.append(image, mosaicCanvas, svg);
    body.append(shell);

    const editor = {
      originalDataUrl:dataUrl,
      title,
      filenameBase,
      image,
      mosaicCanvas,
      mosaicCache:null,
      mosaicFailed:false,
      shell,
      svg,
      body,
      status,
      shapes:[],
      redo:[],
      interaction:null,
      tool:"browse",
      tools:null,
      subBar:null,
      undoBtn:null,
      redoBtn:null,
      fitWidth:true
    };
    resultEditor = editor;
    const tools = buildResultAnnotationTools(editor);
    const subBar = createAttributeSubBar({
      getActiveTool: () => editor.tool,
      onChange: () => {
        if (activeTextEditor && editor.tool === "text") activeTextEditor.refreshStyle(textSize);
        positionResultSubBar(editor);
      }
    });
    editor.subBar = subBar;

    const zoom = button("100%", t("capOriginalSize", "按图片原始尺寸显示"), () => {
      commitActiveTextEditor();
      editor.fitWidth = !editor.fitWidth;
      image.classList.toggle("fit-width", editor.fitWidth);
      image.classList.toggle("actual-size", !editor.fitWidth);
      zoom.textContent = editor.fitWidth ? "100%" : t("capFitWidth", "适应宽度");
      zoom.title = editor.fitWidth ? t("capOriginalSize", "按图片原始尺寸显示") : t("capFitPreviewWidth", "缩放到适应预览宽度");
      if (editor.fitWidth) body.scrollLeft = 0;
      syncResultPreviewSize(editor);
    });
    const copy = iconButton("copy", t("capCopyToClipboard", "复制到剪贴板"), async () => {
      try {
        commitActiveTextEditor();
        status.classList.remove("error");
        status.textContent = editor.shapes.length ? t("capRenderCopy", "正在合成标注并复制…") : t("capCopying", "正在复制…");
        await copyDataUrl(await buildResultDataUrl(editor));
        status.textContent = t("capCopied", "✓ 已复制到剪贴板");
      } catch (e) {
        status.classList.add("error");
        status.textContent = t("capCopyFailed", "复制失败，可点击重试");
        showToast(String(e.message||e),2800);
      }
    }, "", t("capCopy", "复制"), 15);
    const save = iconButton("save", t("capSavePng", "保存 PNG"), async () => {
      try {
        commitActiveTextEditor();
        status.classList.remove("error");
        status.textContent = editor.shapes.length ? t("capRenderingAnnotations", "正在合成标注…") : t("capOpeningSaveDialog", "正在打开保存对话框…");
        const output = await buildResultDataUrl(editor);
        await browser.runtime.sendMessage({ type:"foxshot.download", dataUrl:output, filename:`${filenameBase}-${stamp()}.png` });
        status.textContent = t("capSaveSent", "✓ 已交给 Firefox 保存");
      } catch (error) {
        status.classList.add("error");
        status.textContent = t("capSaveFailed", "保存失败");
        showToast(t("capSaveFailedDetail", "保存失败：$1", String(error?.message || error)), 4200);
      }
    }, "primary", t("capSavePng", "保存 PNG"), 15);
    const close = iconButton("close", t("capClose", "关闭"), destroyUI, "fx-icon-action fx-close", "", 16);
    const actions = make("div", "result-actions");
    actions.append(zoom, copy, save, close);
    head.append(titleGroup, tools, actions);
    wrap.append(head, body);
    ui.shadow.append(wrap, subBar.el);

    bindResultDrawing(editor);
    setResultTool(editor, "browse");
    image.addEventListener("load", () => {
      syncResultPreviewSize(editor);
      if (editor.tool === "mosaic" || editor.shapes.some((s) => s.type === "mosaic")) {
        ensureResultMosaicCache(editor);
      }
      renderResultShapes(editor);
    });
    image.src = dataUrl;
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => syncResultPreviewSize(editor));
      observer.observe(image);
      editor.resizeObserver = observer;
    }

    if (autoCopy) {
      Promise.resolve().then(async () => {
        try {
          await copyDataUrl(dataUrl);
          if (ui?.host?.isConnected) status.textContent = t("capCopied", "✓ 已复制到剪贴板");
        } catch (error) {
          if (!ui?.host?.isConnected) return;
          status.classList.add("error");
          status.textContent = t("capAutoCopyFailed", "自动复制失败，可点击重试");
          console.warn("FoxShot automatic clipboard copy failed", error);
        }
      });
    }
  }

  function showResult(canvas, title, filenameBase, autoCopy = true) {
    showResultDataUrl(canvas.toDataURL("image/png"), title, filenameBase, autoCopy);
  }

  function elementUnderUI(x, y) {
    return hideCaptureUIForProbe(() => {
      const px = clamp(x, 0, innerWidth - 1), py = clamp(y, 0, innerHeight - 1);
      let element = document.elementFromPoint(px, py);
      // The document hit test retargets inside shadow trees to their host.
      // Walk open shadow roots to find the actual internal scroll target.
      for (let depth = 0; depth < 12 && element?.shadowRoot; depth += 1) {
        const inside = element.shadowRoot.elementFromPoint(px, py);
        if (!inside || inside === element) break;
        element = inside;
      }
      return element;
    });
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
      element = element.parentElement || element.getRootNode()?.host || null;
    }
    return makeScroller(null);
  }

  function findForegroundScroller(surface) {
    if (!surface?.isConnected) return null;
    const candidates = [];
    function scan(root) {
      for (const element of root.querySelectorAll("*")) {
        if (isScrollableElement(element)) {
          const r = element.getBoundingClientRect();
          const width = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
          const height = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
          if (width > 40 && height > 40) candidates.push({ element, area: width * height });
        }
        if (element.shadowRoot) scan(element.shadowRoot);
      }
    }
    scan(surface);
    // Prefer the main content pane over narrow scrollable menus/widgets.
    candidates.sort((a, b) => b.area - a.area);
    return candidates.length ? makeScroller(candidates[0].element) : null;
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

  function rememberCaptureScrollControls(scroller) {
    const elements = [scroller.element];
    if (scroller.root && document.body && document.body !== scroller.element) elements.push(document.body);
    const properties = ["scroll-behavior", "scroll-snap-type", "overflow-anchor"];
    return elements.map((element) => ({
      element,
      saved: Object.fromEntries(properties.map((name) => [name, rememberInlineProperty(element, name)]))
    }));
  }

  function applyCaptureScrollControls(savedControls) {
    for (const entry of savedControls) {
      entry.element.style.setProperty("scroll-behavior", "auto", "important");
      entry.element.style.setProperty("scroll-snap-type", "none", "important");
      entry.element.style.setProperty("overflow-anchor", "none", "important");
    }
  }

  function restoreCaptureScrollControls(savedControls) {
    for (const entry of savedControls) {
      for (const [name, saved] of Object.entries(entry.saved)) {
        restoreInlineProperty(entry.element, name, saved);
      }
    }
  }

  async function settleScroller(scroller, top) {
    scroller.setTop(top);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Give lazy rendering and browser scroll correction a short window, then
    // require both scroll position and scroll height to stop moving.
    await sleep(90);
    let lastTop = scroller.getTop();
    let lastHeight = scroller.getTotalHeight();
    let stableSamples = 0;
    for (let sample = 0; sample < 6; sample += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await sleep(24);
      const currentTop = scroller.getTop();
      const currentHeight = scroller.getTotalHeight();
      if (Math.abs(currentTop - lastTop) <= 0.25 && Math.abs(currentHeight - lastHeight) <= 0.5) {
        stableSamples += 1;
        if (stableSamples >= 2) return currentTop;
      } else {
        stableSamples = 0;
      }
      lastTop = currentTop;
      lastHeight = currentHeight;
    }
    return scroller.getTop();
  }

  async function seekScrollerWithoutGap(scroller, cursor, overlap) {
    let targetTop = Math.max(0, cursor - overlap);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const totalHeight = scroller.getTotalHeight();
      const maxScroll = Math.max(0, totalHeight - scroller.getViewportHeight());
      targetTop = Math.min(targetTop, maxScroll);
      const actualTop = await settleScroller(scroller, targetTop);
      if (actualTop <= cursor + 0.5) return actualTop;

      // The browser moved farther down than requested (for example because of
      // scroll-snap or a layout shift). Move the next request back by the exact
      // overshoot. Never accept a frame whose viewport begins after the first
      // uncaptured content coordinate, because that would create a silent gap.
      const overshoot = actualTop - cursor;
      targetTop = Math.max(0, targetTop - overshoot - overlap - 1);
    }
    throw new Error(t("capScrollJumpError", "页面滚动位置持续跳跃，为避免漏截已停止；请稍后重试"));
  }

  function stickyIsPinned(style, rect) {
    if (style.position !== "sticky") return false;
    const top = style.top !== "auto" ? Number.parseFloat(style.top) : NaN;
    const bottom = style.bottom !== "auto" ? Number.parseFloat(style.bottom) : NaN;
    if (Number.isFinite(top) && Math.abs(rect.top - top) <= 3) return true;
    if (Number.isFinite(bottom) && Math.abs(innerHeight - rect.bottom - bottom) <= 3) return true;
    return false;
  }

  function visibleFloatingElements() {
    const result = [];
    const seen = new Set();
    const xs = [6, innerWidth * 0.2, innerWidth * 0.4, innerWidth * 0.6, innerWidth * 0.8, Math.max(6, innerWidth - 6)];
    const ys = [6, 28, 56, 96, innerHeight * 0.25, innerHeight * 0.5, innerHeight * 0.75, Math.max(6, innerHeight - 6)];

    for (const x of xs) {
      for (const y of ys) {
        for (const leaf of document.elementsFromPoint(clamp(x, 0, innerWidth - 1), clamp(y, 0, innerHeight - 1))) {
          let element = leaf;
          while (element && element !== document.documentElement && element !== document.body) {
            if (element === ui?.host || element?.dataset?.foxshotUi === "true") break;
            if (!seen.has(element)) {
              seen.add(element);
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
              if (visible && (style.position === "fixed" || stickyIsPinned(style, rect))) {
                result.push(element);
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

  function hideVisibleFloatingElements(saved) {
    // Fixed overlays can be hidden safely because they do not participate in
    // document flow. A pinned sticky element is different: visibility:hidden
    // preserves its in-flow box, and when a capture seam lands while it is
    // entering the sticky state that preserved box becomes a blank horizontal
    // stripe in the stitched image. Neutralize sticky positioning instead so
    // the element stays in normal document flow and is captured exactly once.
    for (let pass = 0; pass < 4; pass += 1) {
      let changed = false;
      for (const element of visibleFloatingElements()) {
        if (saved.has(element)) continue;
        const style = getComputedStyle(element);
        if (style.position === "sticky") {
          saved.set(element, {
            kind: "sticky",
            position: rememberInlineProperty(element, "position")
          });
          element.style.setProperty("position", "relative", "important");
        } else {
          saved.set(element, {
            kind: "hidden",
            visibility: rememberInlineProperty(element, "visibility")
          });
          element.style.setProperty("visibility", "hidden", "important");
        }
        changed = true;
      }
      if (!changed) break;
    }
  }

  function restoreFloatingElements(saved) {
    for (const [element, state] of saved.entries()) {
      if (state?.kind === "sticky") {
        restoreInlineProperty(element, "position", state.position);
      } else {
        // Accept the old map shape as well so cleanup remains safe if capture
        // is interrupted while code is being hot-reloaded during development.
        restoreInlineProperty(element, "visibility", state?.visibility ?? state);
      }
    }
  }

  async function shouldHideFloatingElements() {
    try {
      const settings = await browser.storage.local.get({ hideFloatingElements: true });
      return settings.hideFloatingElements !== false;
    } catch (_) {
      return true;
    }
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

  function framePixelDiffScore(prevPixels, prevWidth, prevHeight, currPixels, currWidth, currHeight, overlap, matchHeight) {
    const h = Math.max(1, Math.min(matchHeight, overlap, currHeight, prevHeight));
    const prevStartY = prevHeight - overlap;
    if (prevStartY < 0 || prevStartY + h > prevHeight) return Infinity;

    // Sample enough pixels to lock onto text/edges while keeping long captures
    // cheap. Ignore nearly-flat samples because dark/white backgrounds make
    // many vertical offsets look equally good.
    const stepX = Math.max(2, Math.floor(Math.min(prevWidth, currWidth) / 120));
    const stepY = 2;
    const width = Math.min(prevWidth, currWidth);
    let weightedError = 0;
    let weightTotal = 0;

    for (let y = 0; y < h; y += stepY) {
      const py = prevStartY + y;
      const cy = y;
      for (let x = 0; x < width; x += stepX) {
        const pp = (py * prevWidth + x) * 4;
        const cp = (cy * currWidth + x) * 4;
        const pLum = (prevPixels[pp] * 3 + prevPixels[pp + 1] * 6 + prevPixels[pp + 2]) / 10;
        const cLum = (currPixels[cp] * 3 + currPixels[cp + 1] * 6 + currPixels[cp + 2]) / 10;

        // Give edges/text more influence than empty background.
        let edge = 0;
        if (x + stepX < width) {
          const pn = (py * prevWidth + Math.min(width - 1, x + stepX)) * 4;
          const cn = (cy * currWidth + Math.min(width - 1, x + stepX)) * 4;
          const pNext = (prevPixels[pn] * 3 + prevPixels[pn + 1] * 6 + prevPixels[pn + 2]) / 10;
          const cNext = (currPixels[cn] * 3 + currPixels[cn + 1] * 6 + currPixels[cn + 2]) / 10;
          edge = Math.max(Math.abs(pNext - pLum), Math.abs(cNext - cLum));
        }
        const weight = edge >= 8 ? 3 : edge >= 3 ? 1.5 : 0.2;
        weightedError += Math.abs(pLum - cLum) * weight;
        weightTotal += weight;
      }
    }
    return weightTotal > 0 ? weightedError / weightTotal : Infinity;
  }

  async function calibrateFramePlacements(frames, scale, task = null) {
    assertCaptureRunning(task);
    if (frames.length < 2) return frames;

    const decoded = [];
    for (const frame of frames) {
      assertCaptureRunning(task);
      const image = await loadImage(frame.dataUrl);
      assertCaptureRunning(task);
      const w = Math.max(1, Math.round(frame.cropWidth * scale));
      const h = Math.max(1, Math.round(frame.cropHeight * scale));
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        image,
        frame.cropX * scale,
        frame.cropY * scale,
        frame.cropWidth * scale,
        frame.cropHeight * scale,
        0,
        0,
        w,
        h
      );
      decoded.push({
        width: w,
        height: h,
        pixels: ctx.getImageData(0, 0, w, h).data
      });
    }

    const corrected = frames.map((frame) => ({ ...frame }));
    for (let index = 1; index < corrected.length; index += 1) {
      assertCaptureRunning(task);
      const prevFrame = corrected[index - 1];
      const currFrame = corrected[index];
      const prev = decoded[index - 1];
      const curr = decoded[index];

      const predictedOverlapCss =
        (prevFrame.outY + prevFrame.cropHeight) - currFrame.outY;
      const predictedOverlap = Math.max(1, Math.round(predictedOverlapCss * scale));
      const radius = Math.max(24, Math.round(72 * scale));
      const minOverlap = Math.max(12, predictedOverlap - radius);
      const maxOverlap = Math.min(
        prev.height - 1,
        curr.height - 1,
        predictedOverlap + radius
      );
      if (maxOverlap <= minOverlap) continue;

      let best = null;
      let second = null;
      for (let overlap = minOverlap; overlap <= maxOverlap; overlap += 1) {
        const matchHeight = Math.min(Math.round(84 * scale), overlap, curr.height);
        const score = framePixelDiffScore(
          prev.pixels, prev.width, prev.height,
          curr.pixels, curr.width, curr.height,
          overlap, matchHeight
        );
        const candidate = { overlap, score };
        if (!best || score < best.score) {
          second = best;
          best = candidate;
        } else if (!second || score < second.score) {
          second = candidate;
        }
      }

      // Exact/static captures score near zero. Dynamic pages may be noisier, so
      // accept a visual correction when it is either very close or clearly
      // better than the alternatives. Clamp the correction to the search
      // radius so a repetitive background cannot create a wild jump.
      if (!best || !Number.isFinite(best.score)) continue;
      const separation = second ? second.score - best.score : Infinity;
      const trustworthy = best.score <= 3.5 || separation >= Math.max(0.35, best.score * 0.08);
      if (!trustworthy) continue;

      const bestOverlapCss = best.overlap / scale;
      const correctedOutY = prevFrame.outY + prevFrame.cropHeight - bestOverlapCss;
      const delta = correctedOutY - currFrame.outY;
      const maxDelta = radius / scale;
      if (Math.abs(delta) <= maxDelta + 0.5) currFrame.outY = correctedOutY;
    }
    return corrected;
  }

  async function captureScrollerRange(scroller, options) {
    const task = options.task || null;
    assertCaptureRunning(task);
    const start = Math.max(0, Number(options.start) || 0);
    const requestedEnd = Math.max(start + 1, Number(options.end) || start + 1);
    const screenX = Math.max(0, Number(options.screenX) || 0);
    const width = Math.max(1, Number(options.width) || 1);
    const status = options.status || null;
    // Content dialogs must never be mistaken for repeated floating navigation.
    const hideFloating = options.hideFloatingElements ?? (!ui?.foreground && await shouldHideFloatingElements());
    const frames = [];
    let cursor = start;
    let scale = null;
    let iterations = 0;
    const floatingEntries = new Map();
    const scrollControls = rememberCaptureScrollControls(scroller);
    // A generous overlap lets the compositor visually register adjacent
    // frames when Firefox's captured bitmap lags/leads scrollTop by a few
    // pixels (seen on long terminal/log pages and virtualized content).
    const overlap = Math.max(72, Math.min(128, Math.round(scroller.getViewportHeight() * 0.16)));

    applyCaptureScrollControls(scrollControls);
    try {
      while (cursor < requestedEnd - 0.5) {
        assertCaptureRunning(task);
        if (++iterations > 220) throw new Error(t("capTooManyFrames", "截图段数过多，请缩短范围后重试"));
        const totalHeight = scroller.getTotalHeight();
        const end = Math.min(requestedEnd, totalHeight);
        if (cursor >= end - 0.5) break;

        const actualTop = await seekScrollerWithoutGap(scroller, cursor, overlap);
        assertCaptureRunning(task);
        const viewportRect = scroller.getRect();
        const desiredStart = Math.max(start, cursor - overlap);
        const contentStart = Math.max(desiredStart, actualTop);
        if (contentStart > cursor + 0.5) {
          throw new Error(t("capScrollGapError", "滚动定位跳过了尚未捕获的内容，为避免漏截已停止"));
        }

        const contentOffset = Math.max(0, contentStart - actualTop);
        const visibleAvailable = Math.max(0, viewportRect.h - contentOffset);
        const cssHeight = Math.min(visibleAvailable, end - contentStart);
        if (cssHeight <= 0.5) throw new Error(t("capNoVisibleArea", "滚动区域无法继续捕获"));

        if (status) {
          const pct = Math.min(100, Math.round(((cursor - start + cssHeight) / Math.max(1, requestedEnd - start)) * 100));
          status.textContent = t("capCapturingProgress", "正在生成截图… $1%", pct);
        }

        if (hideFloating) hideVisibleFloatingElements(floatingEntries);
        const topBeforeCapture = scroller.getTop();
        const dataUrl = await captureVisibleWithoutUI(1);
        assertCaptureRunning(task);
        const topAfterCapture = scroller.getTop();

        // A script-driven jump or late layout shift during capture can move the
        // viewport after we calculated the crop. Retry the same uncovered
        // coordinate instead of composing a misaligned frame.
        if (Math.abs(topAfterCapture - topBeforeCapture) > 0.75) continue;

        const image = await loadImage(dataUrl);
        assertCaptureRunning(task);
        if (scale == null) scale = image.width / innerWidth;
        const cropX = clamp(screenX, 0, Math.max(0, innerWidth - 1));
        const cropWidth = Math.min(width, innerWidth - cropX);
        const cropY = clamp(viewportRect.top + contentOffset, 0, Math.max(0, innerHeight - 1));
        const cropHeight = Math.min(cssHeight, innerHeight - cropY);
        if (cropWidth <= 0 || cropHeight <= 0) throw new Error(t("capInvalidCaptureArea", "选区超出可捕获区域"));

        frames.push({
          dataUrl,
          cropX,
          cropY,
          cropWidth,
          cropHeight,
          outY: contentStart - start
        });

        const coveredUntil = contentStart + cropHeight;
        if (coveredUntil <= cursor + 0.5) throw new Error(t("capNoNewContent", "滚动区域没有产生新的可捕获内容"));
        cursor = coveredUntil;
      }

      if (!frames.length || scale == null) throw new Error(t("capNoCapture", "没有捕获到图像"));
      const targetHeight = Math.min(requestedEnd, scroller.getTotalHeight()) - start;
      const usedHeight = Math.max(...frames.map((frame) => frame.outY + frame.cropHeight));
      if (usedHeight + 0.75 < targetHeight) {
        throw new Error(t("capIncompleteCoverage", "截图覆盖范围不完整，为避免生成缺内容的长图已停止"));
      }

      const placedFrames = await calibrateFramePlacements(frames, scale, task);
      assertCaptureRunning(task);
      const calibratedUsedHeight = Math.max(...placedFrames.map((frame) => frame.outY + frame.cropHeight));
      const outputWidth = Math.max(1, Math.round(placedFrames[0].cropWidth * scale));
      // Visual registration may move a frame a few pixels, but the user's
      // requested range is authoritative. Keep the final bitmap exactly that
      // tall and let the canvas clip any calibration guard pixels.
      const outputHeight = Math.max(1, Math.round(targetHeight * scale));
      if (outputHeight > MAX_OUTPUT_HEIGHT || outputWidth > 32000) {
        throw new Error(t("capOutputTooLarge", "截图超过单张图片安全尺寸，请缩短范围后重试"));
      }

      const out = createCanvas(outputWidth, outputHeight);
      const ctx = out.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      for (const frame of placedFrames) {
        assertCaptureRunning(task);
        const image = await loadImage(frame.dataUrl);
        assertCaptureRunning(task);
        ctx.drawImage(
          image,
          frame.cropX * scale,
          frame.cropY * scale,
          frame.cropWidth * scale,
          frame.cropHeight * scale,
          0,
          Math.round(frame.outY * scale),
          Math.round(frame.cropWidth * scale),
          Math.round(frame.cropHeight * scale)
        );
      }
      assertCaptureRunning(task);
      return out.toDataURL("image/png");
    } finally {
      restoreFloatingElements(floatingEntries);
      restoreCaptureScrollControls(scrollControls);
    }
  }

  async function startFullPage() {
    mountBase();
    const task = { cancelled: false };
    currentCapture = task;
    const hud = make("div", "hud", t("capAnalyzing", "正在分析页面…"));
    ui.shadow.append(hud);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const originX = scrollX;
    const originY = scrollY;
    let scroller = null;
    let originTop = 0;
    try {
      assertCaptureRunning(task);
      const foregroundScroller = findForegroundScroller(ui?.foreground);
      if (ui?.foreground && !foregroundScroller) {
        // The foreground dialog fits in the viewport: preserve exactly what
        // the user sees instead of scrolling the page behind the dialog.
        const dataUrl = await captureVisibleWithoutUI();
        assertCaptureRunning(task);
        currentCapture = null;
        showResultDataUrl(dataUrl, t("capFullShotTitle", "整页截图"), "FoxShot-full", true);
        return;
      }
      if (foregroundScroller) {
        scroller = foregroundScroller;
      } else if (rootIsScrollable()) {
        scroller = makeScroller(null);
      } else {
        scroller = findScrollerAt(innerWidth / 2, innerHeight / 2);
      }

      if (scroller.root) {
        originTop = scroller.getTop();
        const totalHeight = scroller.getTotalHeight();
        if (totalHeight > MAX_OUTPUT_HEIGHT) {
          throw new Error(t("capPageTooTall", "页面超过单张图片安全高度，请使用长截图选择需要的部分"));
        }
        hud.textContent = totalHeight > innerHeight + 4
          ? t("capCapturingFull", "正在按固定步长捕获整页…")
          : t("capCapturingCurrent", "正在捕获当前页面…");
        const dataUrl = await captureScrollerRange(scroller, {
          start: 0,
          end: totalHeight,
          screenX: 0,
          width: innerWidth,
          status: hud,
          task
        });
        await settleScroller(scroller, originTop).catch(() => {});
        assertCaptureRunning(task);
        window.scrollTo(originX, originY);
        hud.textContent = t("capFullCopied", "整页截图完成，正在复制…");
        currentCapture = null;
        showResultDataUrl(dataUrl, t("capFullShotTitle", "整页截图"), "FoxShot-full", true);
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
          status: hud,
          task
        });
        assertCaptureRunning(task);
        currentCapture = null;
        showResultDataUrl(dataUrl, t("capFullShotTitle", "整页截图"), "FoxShot-full", true);
        return;
      }

      originTop = scroller.getTop();
      const rect = scroller.getRect();
      if (scroller.getTotalHeight() > MAX_OUTPUT_HEIGHT) {
        throw new Error(t("capScrollerTooTall", "滚动区域超过单张图片安全高度，请使用长截图选择需要的部分"));
      }
      hud.textContent = t("capCapturingInner", "检测到页面内部滚动区域，正在按固定步长捕获…");
      const dataUrl = await captureScrollerRange(scroller, {
        start: 0,
        end: scroller.getTotalHeight(),
        screenX: rect.left,
        width: rect.w,
        status: hud,
        task
      });
      await settleScroller(scroller, originTop).catch(() => {});
      assertCaptureRunning(task);
      hud.textContent = t("capFullCopied", "整页截图完成，正在复制…");
      currentCapture = null;
      showResultDataUrl(dataUrl, t("capFullShotTitle", "整页截图"), "FoxShot-full", true);
    } catch (error) {
      const cancelled = captureWasCancelled(task);
      if (scroller) await settleScroller(scroller, originTop).catch(() => {});
      window.scrollTo(originX, originY);
      if (!cancelled && ui) {
        hud.textContent = t("capFullFailedDetail", "整页截图失败：$1", String(error?.message || error));
        setTimeout(() => { if (ui?.shadow.contains(hud)) destroyUI(); }, 9000);
      }
      if (!cancelled) console.error("FoxShot full-page capture failed", error);
    } finally {
      if (currentCapture === task) currentCapture = null;
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
      borderTopColor: topScreen < rect.top - 0.5 ? "transparent" : "var(--fx-accent)",
      borderBottomColor: bottomScreen > rect.bottom + 0.5 ? "transparent" : "var(--fx-accent)"
    });
    if (ui.sizeLabel) {
      ui.sizeLabel.textContent = `${Math.round(s.width)} × ${Math.round(s.endContentY - s.startContentY)}`;
      ui.sizeLabel.style.display = topScreen >= rect.top - 1 ? "block" : "none";
      ui.sizeLabel.classList.toggle("inside", visibleTop < 34);
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
      s.status.textContent = t("capRangeHeight", "范围高度 $1 px · 拖住下边缘继续向下", Math.round(s.endContentY - s.startContentY));
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
    if (s.capturing) {
      cancelCurrentCapture();
      if (s.status) s.status.textContent = t("capCancelling", "正在取消截图…");
      return;
    }
    stopLongAutoScroll();
    s.scroller.eventTarget.removeEventListener("scroll", s.onScroll, true);
    try {
      await settleScroller(s.scroller, s.originTop).catch(() => {});
      if (s.scroller.root) window.scrollTo(s.originWindowX, s.originWindowY);
    } finally {
      if (s.scrollControls) restoreCaptureScrollControls(s.scrollControls);
      longSession = null;
      destroyUI();
    }
  }

  async function completeLongRange() {
    const s = longSession;
    if (!s || s.capturing) return;
    s.capturing = true;
    stopLongAutoScroll();
    s.scroller.eventTarget.removeEventListener("scroll", s.onScroll, true);
    const rangeHeight = Math.max(1, s.endContentY - s.startContentY);
    const task = { cancelled: false };
    currentCapture = task;
    try {
      if (rangeHeight > MAX_OUTPUT_HEIGHT) {
        throw new Error(t("capSelectionTooTall", "选择范围超过单张长图安全高度，请缩短范围"));
      }
      if (s.status) s.status.textContent = t("capCapturingLong", "正在按选定范围生成长图…");

      // The user's drag defines only the start/end range. Actual capture is a
      // deterministic fixed-step pass, so mouse-wheel distance and drag speed
      // cannot create gaps or overlaps.
      const dataUrl = await captureScrollerRange(s.scroller, {
        start: s.startContentY,
        end: s.endContentY,
        screenX: s.screenX,
        width: s.width,
        status: s.status,
        task
      });

      await settleScroller(s.scroller, s.originTop).catch(() => {});
      assertCaptureRunning(task);
      if (s.scroller.root) window.scrollTo(s.originWindowX, s.originWindowY);
      if (s.scrollControls) restoreCaptureScrollControls(s.scrollControls);
      longSession = null;
      currentCapture = null;
      showResultDataUrl(dataUrl, t("capLongShotTitle", "长截图"), "FoxShot-long", true);
    } catch (error) {
      const cancelled = captureWasCancelled(task);
      await settleScroller(s.scroller, s.originTop).catch(() => {});
      if (s.scroller.root) window.scrollTo(s.originWindowX, s.originWindowY);
      if (cancelled) {
        if (s.scrollControls) restoreCaptureScrollControls(s.scrollControls);
        longSession = null;
        destroyUI();
      } else {
        s.capturing = false;
        s.scroller.eventTarget.addEventListener("scroll", s.onScroll, true);
        renderLongRange();
        if (s.status) s.status.textContent = t("capLongFailedDetail", "长截图失败：$1", String(error?.message || error));
        console.error("FoxShot long capture failed", error);
      }
    } finally {
      if (currentCapture === task) currentCapture = null;
    }
  }

  function buildLongToolbar() {
    const s = longSession;
    const bar = make("div", "toolbar long-bar");
    bar.style.visibility = "hidden";
    const status = make("span", "long-status", t("capExtendHint", "拖住下边缘向下延伸；接近底部会自动滚动"));
    const reselect = iconButton("refresh", t("capReselectHint", "重新选择长截图范围"), () => startLong(), "wide", t("capReselect", "重选"), 15);
    const cancel = iconButton("close", t("capCancelLong", "取消长截图"), cancelLongRange, "fx-icon fx-close", "", 16);
    const complete = iconButton("check", t("capCaptureRange", "按当前范围生成长截图"), completeLongRange, "fx-done", t("capFinish", "完成"), 15);
    bar.append(status, make("span", "sep"), reselect, cancel, complete);
    ui.shadow.append(bar);
    ui.toolbar = bar;
    s.status = status;
    requestAnimationFrame(() => positionLongToolbar());
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
    const scrollControls = rememberCaptureScrollControls(scroller);
    applyCaptureScrollControls(scrollControls);
    const startContentY = clamp(originTop + (startScreenY - rect.top), 0, scroller.getTotalHeight());
    const endContentY = clamp(originTop + (endScreenY - rect.top), startContentY + MIN_SELECTION, scroller.getTotalHeight());

    const originBadge = make("div", "long-origin", t("capOriginLocked", "↑ 起点已锁定"));
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
      scrollControls,
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
    if (ui.hint) ui.hint.style.display = "none";
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
      previous.scroller.setTop(previous.originTop);
      if (previous.scroller.root) window.scrollTo(previous.originWindowX, previous.originWindowY);
      if (previous.scrollControls) restoreCaptureScrollControls(previous.scrollControls);
      longSession = null;
    }
    selection = null; shapes = []; redoShapes = []; interaction = null;
    mountBase();
    const stage = make("div", "stage");
    const hint = make("div", "hint", t("capLongInitialHint", "先框选长截图的宽度和起点；松开后拖住下边缘继续向下延伸"));
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
    if (message?.type === "foxshot.cancel") {
      if (longSession) return cancelLongRange().then(() => ({ok:true}));
      destroyUI();
      return Promise.resolve({ok:true});
    }
    if (message?.type === "foxshot.start") {
      if (message.mode === "region") startRegion();
      else if (message.mode === "full") startFullPage();
      else if (message.mode === "long") startLong();
      return Promise.resolve({ok:true});
    }
    return undefined;
  });

  window.addEventListener("resize", () => {
    if (!ui) return;
    if (resultEditor) positionResultSubBar(resultEditor);
    else if (selection && ui.toolbar) {
      ui.mosaicCache = null;
      ui.mosaicFailed = false;
      syncRegionMosaicClip();
      positionToolbar();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (!ui) return;
    if (activeTextEditor) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelActiveTextEditor();
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopImmediatePropagation();
        commitActiveTextEditor();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (longSession) cancelLongRange().catch(() => destroyUI());
      else destroyUI();
      return;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.isComposing) {
      if (selection && !longSession && !resultEditor) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void finalizeRegion("copy");
      }
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const undo = key === "z" && !event.shiftKey;
    const redo = key === "y" || (key === "z" && event.shiftKey);
    if (!undo && !redo) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (resultEditor?.svg?.isConnected) {
      if (undo) undoResultAnnotation(resultEditor);
      else redoResultAnnotation(resultEditor);
    } else if (undo && shapes.length) {
      redoShapes.push(shapes.pop()); renderShapes();
    } else if (redo && redoShapes.length) {
      shapes.push(redoShapes.pop()); renderShapes();
    }
  }, true);
})();
