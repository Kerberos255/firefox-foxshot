/* SPDX-License-Identifier: MIT */
"use strict";

for (const node of document.querySelectorAll("[data-i18n]")) {
  const text = browser.i18n.getMessage(node.dataset.i18n);
  if (text) node.textContent = text;
}

const COMMAND = "capture-region";
const DEFAULT_SHORTCUT = "Alt+Shift+A";
const input = document.getElementById("shortcut");
const status = document.getElementById("status");

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function keyName(event) {
  if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase();
  if (/^[0-9]$/.test(event.key)) return event.key;
  if (/^F(?:[1-9]|1[0-9])$/.test(event.key)) return event.key.toUpperCase();
  const names = {
    " ": "Space", ",": "Comma", ".": "Period",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    Insert: "Insert", Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down",
    ArrowLeft: "Left", ArrowRight: "Right"
  };
  return names[event.key] || null;
}

input.addEventListener("focus", () => {
  input.classList.add("recording");
  setStatus(browser.i18n.getMessage("pressShortcut"));
});

input.addEventListener("blur", () => input.classList.remove("recording"));

input.addEventListener("keydown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    input.blur();
    setStatus("");
    return;
  }
  if (event.key === "Backspace") {
    input.value = "";
    setStatus(browser.i18n.getMessage("shortcutClearedHint"));
    return;
  }
  const key = keyName(event);
  if (!key) {
    setStatus(browser.i18n.getMessage("invalidShortcut"), true);
    return;
  }
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Command");
  if (!parts.some((item) => item !== "Shift") && !/^F\d+$/.test(key)) {
    setStatus(browser.i18n.getMessage("shortcutNeedsModifier"), true);
    return;
  }
  parts.push(key);
  input.value = parts.join("+");
  setStatus(browser.i18n.getMessage("shortcutReady"));
});

async function loadShortcut() {
  const commands = await browser.commands.getAll();
  const command = commands.find((item) => item.name === COMMAND);
  input.value = command?.shortcut || "";
  return command?.shortcut || "";
}

document.getElementById("save").addEventListener("click", async () => {
  try {
    const requested = input.value.trim();
    await browser.commands.update({ name: COMMAND, shortcut: requested });
    await browser.storage.local.set({ shortcutInitialized: true, shortcutDefaultVersion: 2 });
    const actual = await loadShortcut();
    if (requested && !actual) {
      setStatus(browser.i18n.getMessage("shortcutConflict"), true);
    } else {
      setStatus(browser.i18n.getMessage("shortcutSaved"));
    }
  } catch (error) {
    setStatus(`${browser.i18n.getMessage("shortcutSaveFailed")} ${error?.message || error}`, true);
  }
});

document.getElementById("manage-shortcuts")?.addEventListener("click", async () => {
  try {
    if (browser.commands.openShortcutSettings) {
      await browser.commands.openShortcutSettings();
    } else {
      setStatus(browser.i18n.getMessage("shortcutManagerUnavailable"), true);
    }
  } catch (error) {
    setStatus(`${browser.i18n.getMessage("shortcutManagerUnavailable")} ${error?.message || error}`, true);
  }
});

document.getElementById("reset").addEventListener("click", async () => {
  try {
    if (browser.commands.reset) await browser.commands.reset(COMMAND);
    await browser.commands.update({ name: COMMAND, shortcut: DEFAULT_SHORTCUT });
    await browser.storage.local.set({ shortcutInitialized: true, shortcutDefaultVersion: 2 });
    const actual = await loadShortcut();
    if (!actual) setStatus(browser.i18n.getMessage("shortcutConflict"), true);
    else setStatus(browser.i18n.getMessage("shortcutReset"));
  } catch (error) {
    setStatus(`${browser.i18n.getMessage("shortcutSaveFailed")} ${error?.message || error}`, true);
  }
});

loadShortcut().catch((error) => setStatus(String(error?.message || error), true));
