#!/usr/bin/env python3
"""Wires the native adblock engine into Swift Browser's MainActivity.kt (4 small edits).

Usage (from the repo root):   python3 tools/apply_main_activity_patch.py
Optional path argument:       python3 tools/apply_main_activity_patch.py path/to/MainActivity.kt

All-or-nothing: if any anchor is not found exactly once, nothing is written and the missing
anchor is printed. A backup is saved as MainActivity.kt.bak. Running it twice is harmless.
"""
import re
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "app/src/main/java/com/swift/browser/MainActivity.kt")
src = path.read_text(encoding="utf-8")

if "AdBlockLists.init(context)" in src:
    print("Already patched, nothing to do.")
    sys.exit(0)


def anchor_regex(text: str) -> re.Pattern:
    """Match `text` ignoring differences in whitespace/indentation."""
    parts = [re.escape(p) for p in text.split()]
    return re.compile(r"\s+".join(parts))


EDITS = []

# 1. start the native engine next to the existing list manager
EDITS.append((
    "remember { FilterListManager(context) { eng -> blocker.engine = eng }.also { it.start() } }",
    lambda m: m.group(0) + "\n    remember { com.swift.browser.adblock.AdBlockLists.init(context); 0 }",
))

# 2. per-page switch for cosmetic filters / scriptlets (same rules as the built-in shields)
EDITS.append((
    "fun networkOn(tabId: Long): Boolean = blockingFor(tabId) && SiteShields.key(firstParty[tabId]) !in relaxedSites",
    lambda m: m.group(0) + """
    // Native adblock engine (cosmetic filters + scriptlets): same on/off rules as the built-in shields.
    remember {
        com.swift.browser.adblock.AdBlocker.pageGate = { u ->
            val h = NavigationGuard.host(u)
            h != null && currentBlockingEnabled && !siteShields.isOff(u) &&
                SiteShields.key(u) !in relaxedSites && !blocker.isExemptPage(h) &&
                !blocker.isPaymentHost(h) && !blocker.isSensitivePage(u) &&
                NavigationGuard.registrable(h) != "youtube.com"
        }
        0
    }""",
))

# 3. per-WebView install (cosmetic bridge + document-start script); shortener pages tell the navigation guard
EDITS.append((
    'addJavascriptInterface(BlobDownloads.Bridge(context.applicationContext), "SwiftBlob")',
    lambda m: m.group(0) + "\n            com.swift.browser.adblock.AdBlocker.install(this) { navGuard.markFlow(tabId) }",
))

# 4. network decisions
OLD_NET = """if (networkOn(tabId) && (blocker.shouldBlock(url, firstParty[tabId] ?: "", false) ||
                            blocker.engineBlocks(url, firstParty[tabId], req.requestHeaders?.get("Accept")))) {
                        countBlocked(tabId)
                        return blockedResponse(url)
                    }"""
NEW_NET = """if (networkOn(tabId)) {
                        val page = firstParty[tabId]
                        // Native engine (adblock-rust). "" = allow, "B" = block, "R..." = neutered stand-in resource.
                        val verdict = blocker.nativeVerdict(req, page)
                        if (verdict.startsWith("R")) {
                            com.swift.browser.adblock.AdBlocker.redirectResponse(verdict)?.let {
                                countBlocked(tabId)
                                return it
                            }
                        }
                        val block = blocker.shouldBlock(url, page ?: "", false) || verdict.isNotEmpty() ||
                            (!blocker.nativeReady() &&
                                blocker.engineBlocks(url, page, req.requestHeaders?.get("Accept")))
                        if (block) {
                            countBlocked(tabId)
                            return blockedResponse(url)
                        }
                    }"""
EDITS.append((OLD_NET, lambda m: NEW_NET))

out = src
for text, build in EDITS:
    rx = anchor_regex(text)
    found = list(rx.finditer(out))
    if len(found) != 1:
        print(f"ERROR: expected exactly 1 match, found {len(found)} for:\n  {text[:110]}...")
        print("Nothing was changed. Send me your MainActivity.kt and I will adjust the patch.")
        sys.exit(1)
    m = found[0]
    out = out[:m.start()] + build(m) + out[m.end():]

path.with_suffix(path.suffix + ".bak").write_text(src, encoding="utf-8")
path.write_text(out, encoding="utf-8")
print(f"Patched {path} ({len(EDITS)} edits). Backup: {path}.bak")
