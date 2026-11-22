#!/usr/bin/env python3
"""Flow fix: stalled shortlink steps, dead buttons, blocked payment/app links.

Run from the repo root, AFTER tools/apply_main_activity_patch.py:
    python3 tools/apply_flow_patch.py [repo_root]

Each edit is an exact anchor (whitespace-tolerant) that must match exactly once in app/src/main/java.
If any anchor is missing or ambiguous, NOTHING is written. Backups: <file>.flow.bak
Idempotent: refuses to run twice.
"""
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
SRC = ROOT / "app/src/main/java"


def pat(text: str) -> re.Pattern:
    return re.compile(r"\s+".join(re.escape(t) for t in text.split()))


EDITS = []
def edit(name, old, new):
    EDITS.append((name, old, new))

# ---------- MainActivity.kt ----------
edit("nav guard: native check instead of URL-parameter heuristics",
     'return uri.scheme !in listOf("http", "https")',
     'return handleExternalScheme(context, view, uri)')
edit("external schemes: hand UPI / intent / market links to their apps",
     '{ u, p -> blocker.hasAdParams(u) || blocker.engineBlocksNavigation(u, p) })',
     '{ u, p -> blocker.nativeNavBlocks(u, p) || blocker.engineBlocksNavigation(u, p) },\n            { blocker.nativeReady() })')
edit("popups from child windows keep the real user-gesture flag",
     'navGuard.decidePopup(tabId, url, sourceUrl, true)',
     'navGuard.decidePopup(tabId, url, sourceUrl, isUserGesture)')
edit("network: native engine is the only authority once ready (no substring heuristics on top)",
     '''val block = blocker.shouldBlock(url, page ?: "", false) || verdict.isNotEmpty() ||
                            (!blocker.nativeReady() &&
                                blocker.engineBlocks(url, page, req.requestHeaders?.get("Accept")))''',
     '''val block = if (blocker.nativeReady()) verdict.isNotEmpty()
                            else blocker.shouldBlock(url, page ?: "", false) ||
                                blocker.engineBlocks(url, page, req.requestHeaders?.get("Accept"))
                        if (block) ShieldLog.log("net", tabId, url, false, verdict.ifEmpty { "heuristic" })''')

# ---------- NavigationGuard.kt ----------
edit("guard: engine readiness switch",
     'private val hasAdParams: (String, String?) -> Boolean\n) {',
     'private val hasAdParams: (String, String?) -> Boolean,\n    private val engineReady: () -> Boolean = { false }\n) {')
edit("guard: log every navigation decision",
     '@Synchronized fun decideNavigation(tabId: Long, url: String, pageUrl: String?, isRedirect: Boolean): Verdict {',
     '''@Synchronized fun decideNavigation(tabId: Long, url: String, pageUrl: String?, isRedirect: Boolean): Verdict {
        val v = decideNavigationInner(tabId, url, pageUrl, isRedirect)
        ShieldLog.log("nav", tabId, url, v.allowed, v.reason)
        return v
    }

    @Synchronized private fun decideNavigationInner(tabId: Long, url: String, pageUrl: String?, isRedirect: Boolean): Verdict {''')
edit("guard: scripted (timer) navigations are judged by the ad-host engine, not by TLD guesses",
     '''        // Long after load, no tap: scripted navigation (timer / ad script).
        return if (isVisited(h) || !suspicious(h)) Verdict(Kind.ALLOW, "scripted, host looks ordinary")''',
     '''        // Long after load, no tap: scripted navigation (timer / ad script). Shortener steps live here.
        if (engineReady()) return Verdict(Kind.ALLOW, "scripted after load, engine decides ad hosts")
        return if (isVisited(h) || !suspicious(h)) Verdict(Kind.ALLOW, "scripted, host looks ordinary")''')
edit("guard: log every popup decision",
     '@Synchronized fun decidePopup(tabId: Long, url: String?, pageUrl: String?, hasGesture: Boolean): Verdict {',
     '''@Synchronized fun decidePopup(tabId: Long, url: String?, pageUrl: String?, hasGesture: Boolean): Verdict {
        val v = decidePopupInner(tabId, url, pageUrl, hasGesture)
        ShieldLog.log("popup", tabId, url ?: "", v.allowed, v.reason)
        return v
    }

    @Synchronized private fun decidePopupInner(tabId: Long, url: String?, pageUrl: String?, hasGesture: Boolean): Verdict {''')
edit("guard: a recent tap on a labelled control counts for popups (8 s, not 1.5 s)",
     '''        val tapFresh = t0 - t.tapAt in 0..(if (inFlow) FLOW_TAP_MS else TAP_WINDOW_MS)
        if (!hasGesture && !tapFresh) return Verdict(Kind.BLOCK, "popup without a tap")''',
     '''        val recentControl = t.tapControl && t0 - t.tapAt in 0..CONTROL_WINDOW_MS
        val tapFresh = t0 - t.tapAt in 0..(if (inFlow) FLOW_TAP_MS else TAP_WINDOW_MS)
        if (!hasGesture && !tapFresh && !recentControl) return Verdict(Kind.BLOCK, "popup without a tap")''')
edit("guard: gesture or control-tap popups to non-ad hosts are allowed",
     '        if (isVisited(h)) return Verdict(Kind.ALLOW, "popup to visited site")',
     '''        if (recentControl) return Verdict(Kind.ALLOW, "popup after tapping a control")
        if (hasGesture) return Verdict(Kind.ALLOW, "popup with a user gesture")
        if (isVisited(h)) return Verdict(Kind.ALLOW, "popup to visited site")''')

# ---------- TrackerBlocker.kt ----------
edit("tracker: sign-in / 'verify' style URLs are no longer exempt from request blocking",
     'if (isSensitivePage(pageUrl)) return ""',
     '// Sensitive-looking URLs (verify, auth ...) are not exempt any more: only payment hosts and checkout pages are.')
edit("tracker: narrow the sensitive-word list",
     '"auth|oauth|account|secure|3ds|otp|verify|transaction|invoice|subscribe)($|[/._?&=-])"',
     '"3ds|otp|cvv|card|netbanking)($|[/._?&=-])"')
edit("tracker: native check for main-frame navigations and popups",
     '    /** Navigation / popup destination check against popup rules and plain ad-host rules. */',
     '''    /**
     * Native engine verdict for a main-frame navigation or popup. Uses rule type "document": the engine
     * has no "popup" request type, so $popup-only rules are not seen here (the Kotlin engine still checks them).
     */
    fun nativeNavBlocks(url: String, pageUrl: String?): Boolean {
        if (!AdBlockLists.ready) return false
        val host = hostOf(url) ?: return false
        val pageHost = hostOf(pageUrl) ?: return false
        if (engineWhitelisted(host, url) || isExemptPage(host) || isExemptPage(pageHost)) return false
        if (isPaymentHost(host) || isPaymentHost(pageHost) || isCheckoutPage(pageUrl)) return false
        if (sameOwner(host, pageHost)) return false
        val v = com.swift.browser.adblock.AdBlockNative.nativeCheck(url, pageUrl ?: "", "document", "GET")
        return v.isNotEmpty() && (v[0] == 'B' || v[0] == 'R')
    }

    /** Navigation / popup destination check against popup rules and plain ad-host rules. */''')

# ---------- shields JS (shieldsjs.kt) ----------
edit("page JS: no time-based window.open stub (native side decides with the real gesture)",
     'if (Date.now() - lastTrusted > 1500) return stubWindow();',
     '// Popup decisions are native (onCreateWindow + NavigationGuard), which see the real user gesture.')
edit("page JS: never treat a real link or button as a click-catcher",
     "if (tn === 'IFRAME') { if (!adHostUrl(el.src)) return false; }",
     """if (tn === 'A') { if (!adHostUrl(el.href)) return false; }
    else if (el.closest && el.closest('a[href],button,[role=button],label,input,select,textarea')) return false;
    if (tn === 'IFRAME') { if (!adHostUrl(el.src)) return false; }""")
edit("page JS: sensitive-word list narrowed (matches the Kotlin list)",
     r"var SENS = /(^|[\/._?&=-])(checkout|payments?|pay|order|orders|cart|basket|billing|bank|netbanking|wallet|upi|login|signin|sign-in|auth|oauth|account|secure|3ds|otp|verify|transaction|invoice|subscribe)(",
     r"var SENS = /(^|[\/._?&=-])(checkout|payments?|pay|order|orders|cart|basket|billing|bank|netbanking|upi|login|signin|sign-in|3ds|otp|cvv|card)(")
edit("page JS: control reveal takes a gate flag",
     'function reveal() {',
     'function reveal(gate) {')
edit("page JS: re-enabling disabled buttons only on link-gate pages",
     """          if (e.disabled) e.disabled = false;
          e.removeAttribute('disabled');
          if (e.classList) e.classList.remove('disabled');
          if (e.getAttribute('aria-disabled') === 'true') e.setAttribute('aria-disabled', 'false');""",
     """          if (gate) {
            if (e.disabled) e.disabled = false;
            e.removeAttribute('disabled');
            if (e.classList) e.classList.remove('disabled');
            if (e.getAttribute('aria-disabled') === 'true') e.setAttribute('aria-disabled', 'false');
          }""")
edit("page JS: un-hide an ad-named wrapper only when it wraps a real control",
     "if (cs.display === 'none') n.style.setProperty(",
     """if (cs.display === 'none' && (gate || /(^|[\\s_-])(ad|ads|advert|banner|sponsor)([\\s_-]|$)/i.test(String(n.className || '') + ' ' + (n.id || '')))) n.style.setProperty(""")
edit("page JS: reveal runs on every top page (cheap), full mode only on gate pages",
     "rSI.call(window, function () { if (gated && Date.now() < revealUntil) reveal(); }, 600);",
     "var rvN = 0;\n  rSI.call(window, function () { var g = gated && Date.now() < revealUntil; if (g || (++rvN % 4 === 0)) reveal(g); }, 1000);")


def main() -> int:
    files = list(SRC.rglob("*.kt"))
    if not files:
        print(f"No .kt files under {SRC}. Run from the repo root.")
        return 1
    texts = {p: p.read_text(encoding="utf-8") for p in files}
    if any("ShieldLog.log(\"net\"" in t for t in texts.values()):
        print("Already applied (ShieldLog found). Nothing to do.")
        return 0
    errors = []
    for name, old, new in EDITS:
        rx = pat(old)
        hits = [(p, m) for p in files for m in rx.finditer(texts[p])]
        if len(hits) != 1:
            where = ", ".join(sorted({str(p.relative_to(ROOT)) for p, _ in hits})) or "-"
            errors.append(f"  {name}: {len(hits)} matches ({where})")
            continue
        p, m = hits[0]
        texts[p] = texts[p][:m.start()] + new + texts[p][m.end():]
    if errors:
        print("ERROR: these anchors did not match exactly once. NOTHING was written:")
        print("\n".join(errors))
        print("Send the named files and I will adjust the anchors.")
        return 1
    changed = [p for p in files if texts[p] != p.read_text(encoding="utf-8")]
    for p in changed:
        backup = p.with_name(p.name + ".flow.bak")
        backup.write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
        p.write_text(texts[p], encoding="utf-8")
    print(f"Applied {len(EDITS)} edits to {len(changed)} files:")
    for p in changed:
        print("  " + str(p.relative_to(ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
