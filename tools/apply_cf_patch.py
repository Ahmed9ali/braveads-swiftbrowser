#!/usr/bin/env python3
"""Cloudflare + shortlink-stall + block-score fix. Run from the repo root, AFTER the flow patch and the chain fix:

    python3 tools/apply_cf_patch.py

Also copy the three .kt files from this zip into app/src/main/java/com/swift/browser/ first:
    ChallengeSites.kt (new), ShieldLog.kt (replaces), adblock/AdBlockLists.kt (replaces)

All-or-nothing: every anchor must match exactly once, otherwise nothing is written. Backups: <file>.cf.bak
"""
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
SRC = ROOT / "app/src/main/java/com/swift/browser"


def pat(text: str) -> re.Pattern:
    return re.compile(r"\s+".join(re.escape(t) for t in text.split()))


EDITS = {
    "MainActivity.kt": [
        # 1. persistent memory of Cloudflare challenge sites
        ("val siteShields = remember { SiteShields(context) }",
         "val siteShields = remember { SiteShields(context) }\n    val challengeSites = remember { ChallengeSites(context) }"),
        # 2. page scripts must not patch the browser while a challenge is unsolved
        ("fun exempt(host: String?): Boolean = blocker.isExemptPage(host) || siteShields.isOff(host) || SiteShields.key(host) in relaxedSites",
         "fun exempt(host: String?): Boolean = blocker.isExemptPage(host) || siteShields.isOff(host) || SiteShields.key(host) in relaxedSites || challengeSites.expects(host)"),
        # 3. same for cosmetic filters / scriptlets
        ("!blocker.isPaymentHost(h) && !blocker.isSensitivePage(u) &&",
         "!blocker.isPaymentHost(h) && !blocker.isSensitivePage(u) && !challengeSites.expects(h) &&"),
        # 4. learn challenge sites: look at the page 2.5 s after it loads, reload once with the minimal profile
        ("if (!currentPrivateMode && tabs.firstOrNull { it.id == tabId }?.isPrivate != true) store.addHistory(title, url)",
         """if (!currentPrivateMode && tabs.firstOrNull { it.id == tabId }?.isPrivate != true) store.addHistory(title, url)
                    if (url.startsWith("http") && blockingFor(tabId)) {
                        val cfView = view
                        Handler(Looper.getMainLooper()).postDelayed({
                            if (cfView != null && webViews[tabId] === cfView && cfView.url == url) {
                                cfView.evaluateJavascript(CF_PROBE_JS) { r ->
                                    if (r == "true") {
                                        val k = SiteShields.key(url)
                                        val first = k.isNotEmpty() && challengeSites.learn(k)
                                        ShieldLog.log("cf", tabId, url, true,
                                            if (first) "Cloudflare challenge seen: reloading without page patches" else "challenge still showing")
                                        if (first) cfView.reload()
                                    }
                                }
                            }
                        }, 2500)
                    }"""),
        # 5. do not freeze a shortlink tab's timers while another tab (an ad) is in front
        ("if (isCurrent) wv.onResume() else wv.onPause()",
         "if (isCurrent) wv.onResume() else if (!navGuard.isFlow(tab.id)) wv.onPause()"),
        # 6. page console errors into the shield log
        ('android.util.Log.d("SwiftWeb", "[${msg.messageLevel()}] ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")',
         'android.util.Log.d("SwiftWeb", "[${msg.messageLevel()}] ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")\n'
         '                        if (msg.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) {\n'
         '                            ShieldLog.log("js", tabId, "${msg.message()} @ ${msg.sourceId()}:${msg.lineNumber()}", false, "console error")\n'
         '                        }'),
        # 7. block score: keep the exact-host tracker list on top of the native engine
        ("val block = if (blocker.nativeReady()) verdict.isNotEmpty()",
         "val block = if (blocker.nativeReady()) (verdict.isNotEmpty() || blocker.hostListBlocks(url, page))"),
        # 8. log when shortlink mode switches on
        ("com.swift.browser.adblock.AdBlocker.install(this) { navGuard.markFlow(tabId) }",
         'com.swift.browser.adblock.AdBlocker.install(this) {\n'
         '                ShieldLog.log("flow", tabId, firstParty[tabId] ?: "", true, "shortlink rules matched")\n'
         '                navGuard.markFlow(tabId)\n'
         '            }'),
        ("fun flow() { navGuard.markFlow(tabId) }",
         'fun flow() {\n'
         '                    ShieldLog.log("flow", tabId, firstParty[tabId] ?: "", true, "shortlink page text matched")\n'
         '                    navGuard.markFlow(tabId)\n'
         '                }'),
    ],
    "ShieldsJs.kt": [
        # page patches off on exempt pages and unsolved Cloudflare challenges
        ("if (window.__swiftShields) return;\n  window.__swiftShields = true;",
         "// Exempt pages (Shields down, speed tests, an unsolved Cloudflare challenge): no page patches at all.\n"
         "  try { if (window.SwiftFilter && window.SwiftFilter.exempt && window.SwiftFilter.exempt((location.hostname || '').toLowerCase())) return; } catch (e) {}\n"
         "  if (window.__swiftShields) return;\n  window.__swiftShields = true;"),
        # same for the blob-download hook
        ("||(location.hostname==='www.google.com'&&location.pathname.indexOf('/recaptcha')===0))return;\"",
         "||(location.hostname==='www.google.com'&&location.pathname.indexOf('/recaptcha')===0)||(window.SwiftFilter&&window.SwiftFilter.exempt&&window.SwiftFilter.exempt((location.hostname||'').toLowerCase())))return;\""),
    ],
    "TrackerBlocker.kt": [
        ("/** Navigation / popup destination check against popup rules and plain ad-host rules. */",
         """/**
     * Exact-host tracker list (trackers.txt). Structured, not substring guessing, so it stays on top of the
     * native engine. Same safety guards as the engine checks.
     */
    fun hostListBlocks(url: String, pageUrl: String?): Boolean {
        val host = hostOf(url) ?: return false
        val pageHost = hostOf(pageUrl) ?: return false
        if (!isAdHost(host)) return false
        if (isExemptPage(pageHost) || isExemptPage(host)) return false
        if (isPaymentHost(host) || isPaymentHost(pageHost) || isCheckoutPage(pageUrl)) return false
        if (engineWhitelisted(host, url)) return false
        if (NavigationGuard.registrable(pageHost) == "youtube.com") return false
        return !sameOwner(host, pageHost)
    }

    /** Navigation / popup destination check against popup rules and plain ad-host rules. */"""),
    ],
}


def main() -> int:
    for must, what in (("fun isFlow(", "NavigationGuard.kt"), ("Share shield log", "settingscreen.kt"),
                       ('ShieldLog.log("net"', "MainActivity.kt")):
        if not any(must in p.read_text(encoding="utf-8") for p in SRC.glob("*.kt")):
            print(f"Missing earlier fix ({must!r} not found in {what}). Apply the flow patch and chain fix first.")
            return 1
    for need in ("ChallengeSites.kt", "ShieldLog.kt"):
        if not (SRC / need).exists():
            print(f"Copy {need} from the zip into {SRC} first.")
            return 1
    if "challengeSites" in (SRC / "MainActivity.kt").read_text(encoding="utf-8"):
        print("Already applied. Nothing to do.")
        return 0
    results, errors = {}, []
    for fname, edits in EDITS.items():
        path = SRC / fname
        if not path.exists():
            errors.append(f"  {fname}: file not found")
            continue
        text = path.read_text(encoding="utf-8")
        for old, new in edits:
            hits = list(pat(old).finditer(text))
            if len(hits) != 1:
                errors.append(f"  {fname}: matched {len(hits)} times: {old.strip()[:80]!r}")
                continue
            m = hits[0]
            text = text[:m.start()] + new + text[m.end():]
        results[path] = text
    if errors:
        print("ERROR, nothing written:\n" + "\n".join(errors))
        print("Send me this output and the named file.")
        return 1
    for path, text in results.items():
        path.with_name(path.name + ".cf.bak").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        path.write_text(text, encoding="utf-8")
        print("patched " + str(path.relative_to(ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
