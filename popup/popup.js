/* SPDX-License-Identifier: MIT */
"use strict";

for (const node of document.querySelectorAll("[data-i18n]")) {
  const text = browser.i18n.getMessage(node.dataset.i18n);
  if (text) node.textContent = text;
}

const status = document.getElementById("status");
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
    }
  });
}


document.getElementById("open-settings")?.addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});
