# Privacy Policy

Last updated: 2026-09-10

FoxShot is designed to process screenshots locally in Firefox.

FoxShot does not include analytics, telemetry, advertising, tracking, remote code, an upload service, or a developer-operated network backend. Screenshot pixels, selected regions, annotations, clipboard images, and locally saved files are not transmitted to the developer or to any FoxShot service.

## Page access

FoxShot uses Firefox's `activeTab` permission. Page access is granted only after the user explicitly invokes the extension for the active tab. The `scripting` permission is used to display FoxShot's selection, annotation, and scrolling-capture interface on that active page.

## Screenshot data

Firefox's screenshot API is used to capture the visible area of the active tab. Region, full-page, and scrolling screenshots are cropped, stitched, and annotated locally in the browser.

## Clipboard and downloads

If the user chooses Copy, FoxShot writes the generated PNG to the local system clipboard. If the user chooses Save, FoxShot uses Firefox's downloads API to save the generated PNG to the user's device.

## Local settings

FoxShot may store preferences using Firefox extension local storage. These preferences remain local and are not transmitted to the developer.

## Changes

If FoxShot's data practices change, this policy will be updated before a version using those new practices is released.

## Contact

For questions or issues, use the support channel linked from FoxShot's project repository or AMO listing.
