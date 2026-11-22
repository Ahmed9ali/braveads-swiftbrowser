package com.swift.browser.adblock

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicInteger

/**
 * Public API used by your WebView browser.
 *
 *   Application.onCreate():   AdBlockLists.init(this)
 *   per WebView:              AdBlocker.install(webView)
 *   in your WebViewClient:    return AdBlocker.intercept(request, pageUrl) ?: super.shouldInterceptRequest(view, request)
 */
object AdBlocker {
    @Volatile var enabled: Boolean = true
    val blockedCount = AtomicInteger(0)

    /**
     * Per-page switch for cosmetic filtering and scriptlets: return false to leave that page completely alone
     * (site Shields off, payment pages, ...). Network blocking is gated by the caller.
     */
    @Volatile var pageGate: ((String) -> Boolean)? = null

    private const val BRIDGE = "__swiftAdblock"
    private val EMPTY = ByteArray(0)

    // ---------------------------------------------------------------- network

    /**
     * Verdict for a sub-resource request: "" = allow, "B" = block, "R<data: url>" = serve that neutered
     * resource instead (ad-script stubs that keep anti-adblock checks quiet). Never blocks main-frame loads.
     */
    fun verdict(request: WebResourceRequest, pageUrl: String?): String {
        if (!enabled || !AdBlockNative.available || !AdBlockLists.ready) return ""
        if (request.isForMainFrame) return ""
        val url = request.url.toString()
        if (!url.startsWith("http://") && !url.startsWith("https://") &&
            !url.startsWith("ws://") && !url.startsWith("wss://")
        ) return ""

        val headers = request.requestHeaders ?: emptyMap()
        // Referer / Origin identify the real initiating frame when present; fall back to the top page.
        val source = headerOf(headers, "Referer") ?: headerOf(headers, "Origin") ?: pageUrl ?: return ""
        val type = guessType(request, headers)

        val v = try {
            AdBlockNative.nativeCheck(url, source, type, request.method ?: "GET")
        } catch (t: Throwable) {
            return "" // never break browsing because of an engine problem
        }
        // 'U' (removeparam rewrite): WebView cannot rewrite subresource URLs, so treat as allow.
        return if (v.isEmpty() || v[0] == 'U') "" else v
    }

    /** Turns a [verdict] into a response (null = let the request through). Counts blocked requests. */
    fun responseFor(verdict: String): WebResourceResponse? = when {
        verdict.isEmpty() -> null
        verdict[0] == 'B' -> { blockedCount.incrementAndGet(); blockedResponse() }
        verdict[0] == 'R' -> { blockedCount.incrementAndGet(); redirectResponse(verdict) ?: blockedResponse() }
        else -> null
    }

    /** Convenience for apps without their own blocked-response style: verdict + response in one call. */
    fun intercept(request: WebResourceRequest, pageUrl: String): WebResourceResponse? =
        responseFor(verdict(request, pageUrl))

    /** Response for an "R<data: url>" verdict (a neutered ad script / pixel), or null if it can't be decoded. */
    fun redirectResponse(verdict: String): WebResourceResponse? = dataUrlResponse(verdict.removePrefix("R"))

    private fun blockedResponse() = WebResourceResponse(
        "text/plain", "utf-8", 403, "Blocked", mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(EMPTY)
    )

    /** `data:<mime>;base64,<payload>` produced by the engine for neutered resources. */
    private fun dataUrlResponse(dataUrl: String): WebResourceResponse? {
        if (!dataUrl.startsWith("data:")) return null
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return null
        val meta = dataUrl.substring(5, comma)
        val payload = dataUrl.substring(comma + 1)
        val mime = meta.substringBefore(';').ifEmpty { "text/plain" }
        val bytes = runCatching {
            if (meta.endsWith(";base64")) Base64.decode(payload, Base64.DEFAULT) else payload.toByteArray()
        }.getOrNull() ?: return null
        return WebResourceResponse(mime, "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(bytes))
    }

    private fun headerOf(h: Map<String, String>, name: String): String? =
        h.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.takeIf { it.isNotBlank() }

    /** WebView does not expose the resource type, so infer it (same names adblock-rust accepts). */
    private fun guessType(req: WebResourceRequest, h: Map<String, String>): String {
        headerOf(h, "Sec-Fetch-Dest")?.let {
            when (it) {
                "script", "worker", "sharedworker", "serviceworker" -> return "script"
                "style" -> return "stylesheet"
                "image" -> return "image"
                "font" -> return "font"
                "iframe", "frame" -> return "subdocument"
                "audio", "video", "track" -> return "media"
                "object", "embed" -> return "object"
                "empty" -> return "xmlhttprequest"
            }
        }
        if (headerOf(h, "X-Requested-With").equals("XMLHttpRequest", true)) return "xmlhttprequest"
        val scheme = req.url.scheme
        if (scheme == "ws" || scheme == "wss") return "websocket"

        when (req.url.lastPathSegment?.substringAfterLast('.', "")?.lowercase()) {
            "js", "mjs" -> return "script"
            "css" -> return "stylesheet"
            "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp" -> return "image"
            "woff", "woff2", "ttf", "otf", "eot" -> return "font"
            "mp4", "webm", "mp3", "ogg", "m4a", "m3u8", "mpd", "ts" -> return "media"
        }
        val accept = headerOf(h, "Accept")?.lowercase().orEmpty()
        return when {
            "text/css" in accept -> "stylesheet"
            accept.startsWith("image/") || "image/avif" in accept || "image/webp" in accept -> "image"
            "text/html" in accept -> "subdocument"
            else -> "other"
        }
    }

    // --------------------------------------------------------------- cosmetic

    /**
     * Brave's "aggressive" cosmetic mode (hide everything a rule matches, skip the
     * "is this first-party content?" safety check). Off by default, like Brave.
     * Cross-origin iframes and youtube.com are always aggressive, as in Brave.
     */
    @Volatile var aggressiveMode: Boolean = false

    // ---- Shortlink assist (per-site, opt-in; see assets/adblock/cosmetic.js -> runAssist) ----

    /** Speed factor for countdowns on assisted sites (10 = a 30 s wait takes ~3 s). */
    @Volatile var assistSpeed: Int = 10

    /** Apply assist to every site (not recommended: it stubs window.open and speeds all timers). */
    @Volatile var assistEverywhere: Boolean = false

    private val assistHosts = java.util.concurrent.CopyOnWriteArraySet<String>()

    /** Turn "skip waits / ignore ad clicks" on or off for a host and its subdomains. */
    fun setShortlinkAssist(host: String, enabled: Boolean) {
        val h = host.lowercase().removePrefix("www.")
        if (enabled) assistHosts += h else assistHosts -= h
    }

    fun isShortlinkAssistOn(host: String): Boolean = assistFactorFor("https://$host/") > 1

    private fun assistFactorFor(url: String): Int {
        if (!enabled) return 0
        if (assistEverywhere) return assistSpeed
        val host = runCatching { java.net.URI(url).host }.getOrNull()?.lowercase()?.removePrefix("www.") ?: return 0
        return if (assistHosts.any { host == it || host.endsWith(".$it") }) assistSpeed else 0
    }

    @Volatile private var cosmeticJs: String? = null

    private fun loadCosmeticJs(context: Context): String? {
        cosmeticJs?.let { return it }
        return runCatching {
            context.assets.open("adblock/cosmetic.js").bufferedReader().use { it.readText() }
        }.onFailure { Log.e(TAG, "assets/adblock/cosmetic.js missing", it) }
            .getOrNull()?.also { cosmeticJs = it }
    }

    /** Call once per WebView, right after creating it (before the first loadUrl). */
    @SuppressLint("JavascriptInterface", "RequiresFeature")
    fun install(webView: WebView, onShortlinkPage: (() -> Unit)? = null) {
        if (!AdBlockNative.available) return
        webView.addJavascriptInterface(CosmeticBridge(webView, onShortlinkPage), BRIDGE)
        val js = loadCosmeticJs(webView.context) ?: return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Runs in every frame before the page's own scripts (the JS skips non-http(s) frames).
            WebViewCompat.addDocumentStartJavaScript(webView, js, setOf("*"))
        }
    }

    /**
     * Fallback for WebViews without DOCUMENT_START_SCRIPT support: call from onPageStarted.
     * Top frame only, and a little later than document-start, so a brief flash of ads is possible.
     */
    fun injectFallback(webView: WebView) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val js = loadCosmeticJs(webView.context) ?: return
        webView.evaluateJavascript(js, null)
    }

    /** Exposed to page JS as window.__swiftAdblock. Only returns selectors/scriptlets, no app data. */
    private class CosmeticBridge(webView: WebView, private val onShortlinkPage: (() -> Unit)?) {
        private val webViewRef = WeakReference(webView)

        /** Port of ProcessURL(): url-specific rules + whether this frame is in aggressive mode. */
        @JavascriptInterface
        fun cosmetic(url: String, crossOrigin: Boolean): String {
            if (!enabled || !AdBlockLists.ready || pageGate?.invoke(url) == false) return DISABLED
            return runCatching {
                val json = JSONObject(AdBlockNative.nativeCosmetic(url))
                val youtube = AdBlockNative.nativeIsFirstParty(url, "https://youtube.com/")
                json.put("aggressive", aggressiveMode || crossOrigin || youtube)
                // Pages the shortener list has rules for (timer boosters, focus spoofers): tell the host app so
                // its navigation guard lets the multi-step flow through.
                if (onShortlinkPage != null && SHORTLINK_RULE.containsMatchIn(json.optString("scriptlet"))) {
                    runCatching { onShortlinkPage?.invoke() }
                }
                json.toString()
            }.getOrDefault(DISABLED)
        }

        @JavascriptInterface
        fun assistSpeed(url: String): Int = assistFactorFor(url)

        @JavascriptInterface
        fun hidden(classesJson: String, idsJson: String, exceptionsJson: String): String {
            if (!enabled || !AdBlockLists.ready) return "[]"
            return runCatching {
                AdBlockNative.nativeHiddenClassId(
                    parseArray(classesJson), parseArray(idsJson), parseArray(exceptionsJson)
                )
            }.getOrDefault("[]")
        }

        @JavascriptInterface
        fun isFirstParty(url: String, base: String): Boolean =
            runCatching { AdBlockNative.nativeIsFirstParty(base, url) }.getOrDefault(false)

        /**
         * Page CSP refused our inline scriptlet <script>. evaluateJavascript is not subject to the
         * page's CSP, so run the same scriptlet that way (top frame only).
         */
        @JavascriptInterface
        fun runScriptletFallback(url: String) {
            val webView = webViewRef.get() ?: return
            if (!enabled || pageGate?.invoke(url) == false) return
            val scriptlet = runCatching {
                JSONObject(AdBlockNative.nativeCosmetic(url)).optString("scriptlet")
            }.getOrDefault("")
            if (scriptlet.isEmpty()) return
            webView.post { webView.evaluateJavascript(scriptlet, null) }
        }

        private fun parseArray(json: String): Array<String> {
            val a = JSONArray(json)
            return Array(a.length()) { a.getString(it) }
        }
    }

    private const val TAG = "SwiftAdBlock"
    private const val DISABLED = "{\"disabled\":true}"
    // Invocations (not definitions) of the scriptlets the link-shortener list uses on gate pages.
    private val SHORTLINK_RULE =
        Regex("""try \{ (adjustSet(Interval|Timeout)\(|setConstant\("(blurred|document\.hidden)")""")
}
