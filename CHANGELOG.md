# Changelog

## 1.1

- Lock the underlying page while full-page and scrolling screenshot previews are open so only the FoxShot preview scrollbar remains.
- Default previews to a slightly inset fit-to-width view, with a `100%` / `适应宽度` toggle.
- Add rectangle, ellipse, arrow, pen, text, mosaic, undo, and redo tools directly to full-page and scrolling screenshot previews.
- Copy/save from the preview now composites annotations into the final PNG.
- Ignore visible fixed and currently pinned sticky overlays during stitched capture by default; add a Settings toggle to preserve them when needed.
- Restore page scrolling and temporarily hidden floating elements after capture/preview closes.
- Improve the scrolling-capture range hint contrast for easier reading while extending the lower edge.

## 1.0

- Initial public test release.
- Region screenshot with post-selection resizing/moving and local annotations: rectangle, ellipse, arrow, brush, text, and freehand mosaic.
- Annotation toolbar stays anchored to the selection; selection uses clearer move/resize/forbidden cursors.
- Full-page screenshot uses deterministic fixed-step visible capture and stitching, including detected nested scroll containers.
- Scrolling screenshot uses a locked-start interaction: drag the lower edge downward and the page auto-scrolls near the edge; the drag defines the range, then FoxShot captures that range deterministically.
- Full-page and scrolling screenshots automatically copy the completed PNG to the clipboard while keeping a preview open.
- PNG saving uses Blob/Object URLs for reliable Firefox downloads across all capture modes.
- Clipboard image writes use Firefox's extension `browser.clipboard.setImageData()` API.
- Default region shortcut is `Alt+Shift+A` and remains configurable in settings; an older `Alt+A` default is migrated without overwriting custom shortcuts.
- Avoids Firefox off-screen `rect` capture after real-browser testing exposed `SecurityError: The operation is insecure`.
- Avoids screenshot canvas-to-canvas composition and uses CORS-safe screenshot image loading to reduce Firefox WebExtension canvas security failures.
