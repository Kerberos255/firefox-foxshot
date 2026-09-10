/* SPDX-License-Identifier: MIT */
"use strict";

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function ensureCaptureScript(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "foxshot.ping" });
    return;
  } catch (_) {
    // Not injected yet.
  }

  await browser.scripting.executeScript({
    target: { tabId },
    files: ["content/capture.js"]
  });
}

async function startMode(mode, explicitTab = null) {
  const tab = explicitTab?.id ? explicitTab : await getActiveTab();
  if (!tab?.id) throw new Error("No active tab");
  await ensureCaptureScript(tab.id);
  await browser.tabs.sendMessage(tab.id, { type: "foxshot.start", mode });
}

const SHORTCUT_COMMAND = "capture-region";
const DEFAULT_SHORTCUT = "Alt+Shift+A";
const SHORTCUT_DEFAULT_VERSION = 2;

async function initializeShortcut() {
  try {
    const state = await browser.storage.local.get({ shortcutDefaultVersion: 0 });
    if (state.shortcutDefaultVersion >= SHORTCUT_DEFAULT_VERSION) return;

    const commands = await browser.commands.getAll();
    const command = commands.find((item) => item.name === SHORTCUT_COMMAND);
    // Migrate only the old FoxShot default (or an unassigned command). A custom
    // shortcut chosen by the user must never be overwritten by an update.
    if (!command?.shortcut || command.shortcut === "Alt+A") {
      await browser.commands.update({ name: SHORTCUT_COMMAND, shortcut: DEFAULT_SHORTCUT });
    }
    await browser.storage.local.set({
      shortcutInitialized: true,
      shortcutDefaultVersion: SHORTCUT_DEFAULT_VERSION
    });
  } catch (error) {
    console.warn("FoxShot could not initialize the default shortcut", error);
  }
}

initializeShortcut();

function parseImageDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("Invalid image data");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { format: match[1], bytes };
}

const downloadObjectUrls = new Map();

async function downloadImage(dataUrl, filename) {
  const { format, bytes } = parseImageDataUrl(dataUrl);
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const blob = new Blob([bytes], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const id = await browser.downloads.download({
      url: objectUrl,
      filename,
      saveAs: true,
      conflictAction: "uniquify"
    });
    downloadObjectUrls.set(id, objectUrl);
    return id;
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

browser.downloads.onChanged.addListener((delta) => {
  const objectUrl = downloadObjectUrls.get(delta.id);
  if (!objectUrl) return;
  if (delta.state?.current === "complete" || delta.error?.current) {
    downloadObjectUrls.delete(delta.id);
    // Give the downloads backend a moment to finish consuming the Blob URL.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return undefined;

  if (message.type === "foxshot.startMode") {
    return startMode(message.mode).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error?.message || error) })
    );
  }

  if (message.type === "foxshot.captureVisible") {
    if (sender.tab?.windowId == null) {
      return Promise.reject(new Error("Capture request did not come from a browser tab"));
    }
    const options = { format: "png" };
    const requestedScale = Number(message.scale);
    if (Number.isFinite(requestedScale) && requestedScale > 0) options.scale = requestedScale;
    return browser.tabs.captureVisibleTab(sender.tab.windowId, options);
  }

  if (message.type === "foxshot.copyImage") {
    try {
      const { format, bytes } = parseImageDataUrl(message.dataUrl);
      return browser.clipboard.setImageData(bytes.buffer, format);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  if (message.type === "foxshot.download") {
    const filename = String(message.filename || `FoxShot-${Date.now()}.png`)
      .replace(/[\\/:*?"<>|]+/g, "-");
    try {
      return downloadImage(message.dataUrl, filename);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return undefined;
});

browser.commands.onCommand.addListener((command, tab) => {
  if (command !== SHORTCUT_COMMAND) return;
  startMode("region", tab).catch((error) => {
    console.error("FoxShot shortcut failed", error);
  });
});
