from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"

manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
out = DIST / f"foxshot-{version}.xpi"

INCLUDE = [
    "manifest.json",
    "background.js",
    "LICENSE",
    "README.md",
    "PRIVACY.md",
    "CHANGELOG.md",
    "popup",
    "options",
    "content",
    "icons",
    "_locales",
]

DIST.mkdir(exist_ok=True)
if out.exists():
    out.unlink()

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for item in INCLUDE:
        path = ROOT / item
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file():
                    zf.write(child, child.relative_to(ROOT).as_posix())
        elif path.is_file():
            zf.write(path, path.relative_to(ROOT).as_posix())

print(out)
