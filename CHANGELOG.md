# Changelog

## 1.4

- Redesign the region-capture, scrolling-capture, and preview annotation toolbars with frosted glass surfaces, uniform linear SVG icons (including a floppy-disk save icon), a FoxShot orange accent, and an on-demand secondary attribute bar for stroke/text size and curated color swatches.
- Replace native `window.prompt()` text annotation dialogs with an in-place text editor supporting live color/size updates, `Shift+Enter` line breaks, `Enter` commit, and `Esc` cancel.
- Upgrade mosaic annotation to real-time WYSIWYG pixelation on both region capture and full/long result previews, with global grid alignment across overlapping strokes, single-click dab support, instant undo restoration, and a high-contrast checkerboard fallback.
- Support `Enter` and double-click inside the region selection to copy and finish; toggle an active annotation tool off to return directly to selection dragging.
- Refresh the toolbar popup into a compact Bento layout (primary region-capture card with split shortcut keycaps + side-by-side full-page and scrolling tiles) with concise copy.
- Add an Appearance theme preference (`System` / `Light` / `Dark`, defaulting to `System`) in Settings that applies live across the settings page, popup, capture toolbars, and preview overlay.

## 1.3

- Capture in front of open modal dialogs, including dialogs inside open Shadow DOM, without closing the original dialog.
- Prioritize foreground modal scroll containers for full-page and scrolling screenshots; preserve the modal, content, and original scroll position after capture.
- Support top-layer popovers without dismissing existing page popovers, and retain ordinary-page capture behavior.
- Refresh the capture popup and options page with responsive mode cards, light/dark themes, and keyboard-accessible controls.
- Show the user's actual configured shortcut in the popup and prevent duplicate capture requests while starting.
- Add browser regression tests for modal captures, popup/options interactions, light/dark styling, and Escape cancellation.

## 1.2

- Fix intermittent horizontal seams, missing text rows, and duplicated content in long and full-page screenshots by visually registering overlapping Firefox capture frames instead of trusting scroll coordinates alone.
- Increase capture overlap and calibrate adjacent frames against actual image pixels, including cases where the captured bitmap drifts from the reported scroll position.
- Improve long-capture reliability on pages using `scroll-snap`, smooth scrolling, sticky headers, and nested scroll containers, restoring the page's original scroll behavior afterward.
- Avoid blank bands caused by pinned `position: sticky` elements during stitched captures.
- Add real-Firefox regression coverage for root/nested scrolling, sticky seams, scroll snap, and deliberate 13 px capture drift.

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
