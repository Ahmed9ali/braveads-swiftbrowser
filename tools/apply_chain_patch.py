#!/usr/bin/env python3
"""Chain fix: adds a phone-side shield log share button and keeps shortlink steps in one tab.

Run from the repo root AFTER the flow patch:   python3 tools/apply_chain_patch.py
Also copy NavigationGuard.kt and ShieldLog.kt from this zip into app/src/main/java/com/swift/browser/
(they replace your versions; the zip versions already contain the flow patch).
All-or-nothing: if an anchor is not found exactly once, nothing is written.
"""
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
SRC = ROOT / "app/src/main/java/com/swift/browser"

ANCHORS = {
    "settingscreen.kt": [
        ('    PageScaffold("Privacy and security", onBack) {',
         '    val shieldCtx = androidx.compose.ui.platform.LocalContext.current\n'
         '    PageScaffold("Privacy and security", onBack) {'),
        ('            item { SRow(Icons.Default.DeleteSweep, "Clear browsing data", "Cookies, site data, cache", onClick = onClearData) { Chevron() } }',
         '            item { SRow(Icons.Default.DeleteSweep, "Clear browsing data", "Cookies, site data, cache", onClick = onClearData) { Chevron() } }\n'
         '            item { SRow(Icons.Default.Info, "Share shield log", "Blocking decisions from this session, to test or report a site", onClick = { ShieldLog.share(shieldCtx) }) { Chevron() } }'),
    ],
    "MainActivity.kt": [
        ('if (decidedAllowed && sameSiteOpen && view != null) {',
         'if (decidedAllowed && (sameSiteOpen || (!isDialog && navGuard.isFlow(tabId))) && view != null) {'),
    ],
}


def pat(text: str) -> re.Pattern:
    return re.compile(r"\s+".join(re.escape(t) for t in text.split()))


def main() -> int:
    if not SRC.exists():
        print(f"Not found: {SRC}. Run from the repo root.")
        return 1
    if "Share shield log" in (SRC / "settingscreen.kt").read_text(encoding="utf-8"):
        print("Already applied. Nothing to do.")
        return 0
    results, errors = {}, []
    for fname, edits in ANCHORS.items():
        path = SRC / fname
        if not path.exists():
            errors.append(f"  {fname}: file not found")
            continue
        text = path.read_text(encoding="utf-8")
        for old, new in edits:
            hits = list(pat(old).finditer(text))
            if len(hits) != 1:
                errors.append(f"  {fname}: anchor matched {len(hits)} times: {old.strip()[:70]}")
                continue
            m = hits[0]
            text = text[:m.start()] + new + text[m.end():]
        results[path] = text
    if errors:
        print("ERROR, nothing written:\n" + "\n".join(errors))
        print("Send the output of this script and the named file, and I will adjust the anchor.")
        return 1
    for path, text in results.items():
        path.with_name(path.name + ".chain.bak").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        path.write_text(text, encoding="utf-8")
        print("patched " + str(path.relative_to(ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
