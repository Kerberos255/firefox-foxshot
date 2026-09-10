/* SPDX-License-Identifier: MIT */
"use strict";

for (const node of document.querySelectorAll("[data-i18n]")) {
  const text = browser.i18n.getMessage(node.dataset.i18n);
  if (text) node.textContent = text;
}

const status = document.getElementById("status");
for (const button of document.querySelectorAll("button[data-mode]")) {
  button.addEventListener("click", async () => {
    status.textContent = "";
    const response = await browser.runtime.sendMessage({
      type: "foxshot.startMode",
      mode: button.dataset.mode
    });
    if (!response?.ok) {
      status.textContent = response?.error || browser.i18n.getMessage("cannotCapture");
      return;
    }
    window.close();
  });
}


document.getElementById("open-settings")?.addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});
