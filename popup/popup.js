/* SPDX-License-Identifier: MIT */
"use strict";

for (const node of document.querySelectorAll("[data-i18n]")) {
  const text = browser.i18n.getMessage(node.dataset.i18n);
  if (text) node.textContent = text;
}

const status = document.getElementById("status");
const modeButtons = [...document.querySelectorAll("button[data-mode]")];
const shortcutBadge = document.querySelector(".kbd-badge");
const settingsButton = document.getElementById("open-settings");
const settingsLabel = browser.i18n.getMessage("settings") || "Settings";
if (settingsButton) {
  settingsButton.title = settingsLabel;
  settingsButton.setAttribute("aria-label", settingsLabel);
}

// Commands are user-customizable, so never display the original default as
// though it were the current shortcut.
async function displayCurrentShortcut() {
  try {
    const commands = await browser.commands.getAll();
    const shortcut = commands.find((item) => item.name === "capture-region")?.shortcut;
    if (shortcutBadge && shortcut) {
      shortcutBadge.textContent = shortcut;
      shortcutBadge.hidden = false;
    }
  } catch (error) {
    console.warn("FoxShot could not read the current shortcut", error);
  }
}
void displayCurrentShortcut();
let starting = false;
let cancelledStart = false;
window.addEventListener("keydown", (event) => {
  if (!starting || event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  cancelledStart = true;
  browser.runtime.sendMessage({ type: "foxshot.cancelMode" })
    .catch(console.error)
    .finally(() => window.close());
}, true);
for (const button of document.querySelectorAll("button[data-mode]")) {
  button.addEventListener("click", async () => {
    if (starting) return;
    starting = true;
    modeButtons.forEach((item) => { item.disabled = true; });
    cancelledStart = false;
    status.textContent = "";
    try {
      const response = await browser.runtime.sendMessage({
        type: "foxshot.startMode",
        mode: button.dataset.mode
      });
      if (cancelledStart || response?.cancelled) {
        window.close();
        return;
      }
      if (!response?.ok) {
        status.textContent = response?.error || browser.i18n.getMessage("cannotCapture");
        return;
      }
      window.close();
    } catch (error) {
      if (!cancelledStart) status.textContent = String(error?.message || error);
    } finally {
      starting = false;
      modeButtons.forEach((item) => { item.disabled = false; });
    }
  });
}


document.getElementById("open-settings")?.addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});
