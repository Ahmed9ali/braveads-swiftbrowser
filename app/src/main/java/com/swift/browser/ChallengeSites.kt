package com.swift.browser

import android.content.Context
import android.webkit.CookieManager

/**
 * Sites that put a Cloudflare "Just a moment..." challenge in front of their pages.
 *
 * That challenge runs on the site's OWN address (not on challenges.cloudflare.com), and it inspects the
 * browser for tampering. So until the challenge is solved (no cf_clearance cookie yet), pages of a learned site
 * get no page-side shield patches at all. Network blocking stays on. Once cf_clearance exists, normal shields apply.
 */
class ChallengeSites(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("swift_challenge_sites", Context.MODE_PRIVATE)
    private val sites = HashSet(sp.getStringSet("sites", emptySet()) ?: emptySet())

    @Synchronized fun has(key: String): Boolean = key in sites

    /** Remembers the site. True only the first time, so the caller reloads once and never loops. */
    @Synchronized fun learn(key: String): Boolean {
        if (key.isEmpty() || !sites.add(key)) return false
        sp.edit().putStringSet("sites", HashSet(sites)).apply()
        return true
    }

    /** True while this site's challenge is expected and not yet solved. */
    fun expects(host: String?): Boolean {
        val k = SiteShields.key(host)
        if (k.isEmpty()) return false
        val known = synchronized(this) { k in sites }
        if (!known) return false
        val cookies = runCatching { CookieManager.getInstance().getCookie("https://$host") }.getOrNull().orEmpty()
        return !cookies.contains("cf_clearance")
    }
}

/**
 * True when the page is Cloudflare's interstitial. Deliberately narrow: pages that only embed a
 * Turnstile widget (login forms) must not match, or their shields would be switched off forever.
 */
const val CF_PROBE_JS = """
(function () {
  try {
    var t = (document.title || '').toLowerCase();
    if (/just a moment|attention required|checking your browser/.test(t)) return true;
    return !!document.querySelector('#challenge-running,#cf-challenge-running,#challenge-form,#challenge-stage');
  } catch (e) { return false; }
})();
"""
