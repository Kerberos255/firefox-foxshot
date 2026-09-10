# FoxShot

FoxShot is a lightweight Firefox screenshot extension that works entirely on-device.

## Features

- **Region screenshot** — drag to select an area, resize/move the selection after mouse-up, then annotate with rectangles, ellipses, arrows, brush strokes, text, and freehand mosaic strokes.
- **Full-page screenshot** — captures the page in deterministic fixed-height steps and stitches the original screenshot frames directly. It works with ordinary document scrolling and detected nested scroll containers.
- **Scrolling screenshot** — select the width and starting point, then drag the lower edge downward. Near the bottom of the scroll area FoxShot auto-scrolls while the start stays locked. The drag only defines the range; after you click **Finish**, FoxShot captures that range in deterministic steps, so human scroll distance cannot create gaps or overlaps.
- Completed full-page and scrolling screenshots are copied to the clipboard automatically and also shown in a preview; PNG save remains available.
- **Keyboard shortcut** — region capture defaults to `Alt+Shift+A` and can be changed from FoxShot settings.

## Privacy

FoxShot has no analytics, telemetry, advertising, remote code, upload service, or network backend. Screenshots and annotations are processed locally in Firefox. See [PRIVACY.md](PRIVACY.md).

## Permissions

- `activeTab` — capture only the tab the user explicitly invokes FoxShot on.
- `scripting` — inject the selection/capture UI into the active page after the user starts a screenshot.
- `downloads` — save PNG files locally.
- `clipboardWrite` — copy screenshot images to the clipboard.
- `storage` — remember local shortcut initialization/settings state; nothing is uploaded.

The screenshot shortcut is implemented with Firefox's `commands` API and does not require an additional permission.

FoxShot intentionally does **not** request `<all_urls>` or the broad `tabs` permission.

## Firefox support

- Manifest V3
- Firefox 140+

Some browser-internal or otherwise protected pages do not permit script injection, so selection-based modes may not work there.

## Local testing

1. Open `about:debugging` in Firefox.
2. Choose **This Firefox**.
3. Choose **Load Temporary Add-on**.
4. Select `manifest.json` from this project.

## Build

Requires Python 3:

```bash
python tools/build.py
```

Output: `dist/foxshot-1.0.xpi` (unsigned; AMO signing is required for normal permanent installation on Firefox Release).

## Current 1.0 boundaries

- Full-page and scrolling capture use deterministic visible-viewport sampling rather than Firefox off-screen `rect` capture. This keeps page access at `activeTab` scope and avoids current Firefox security/Canvas edge cases found during testing.
- Single-image output is currently limited to a conservative safe height of 32,000 pixels.
- Scrolling screenshot is optimized for vertical capture. The selected width is fixed while the lower edge is extended downward.

## License

MIT. See [LICENSE](LICENSE).
